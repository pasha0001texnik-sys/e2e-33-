-- E2E Hub: базовая схема.
-- Стенды, сюиты, прогоны, шаги, логи, фикстуры, расписания, аудит.
-- Production-окружение в типе stand_env не представимо намеренно.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Типы
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('viewer', 'qa', 'admin');
create type public.stand_env as enum ('dev', 'qa', 'staging');
create type public.run_status as enum ('queued', 'running', 'paused', 'passed', 'failed', 'cancelled', 'error');
create type public.run_trigger as enum ('manual', 'schedule', 'webhook', 'rerun');
create type public.test_status as enum ('queued', 'running', 'on_hold', 'passed', 'flaky', 'failed', 'skipped', 'cancelled');
create type public.step_status as enum ('running', 'passed', 'failed', 'skipped');
create type public.fixture_status as enum ('created', 'verified', 'in_use', 'cleanup_pending', 'cleaned', 'failed', 'orphaned');
create type public.hold_action as enum ('continue', 'fail', 'abort');
create type public.overlap_policy as enum ('skip', 'queue', 'cancel_previous');
create type public.error_kind as enum ('infra', 'assertion', 'guard', 'timeout', 'cancelled');

-- ---------------------------------------------------------------------------
-- Утилиты
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Хост из URL: https://user@Host.Example:8443/path -> host.example
create or replace function public.url_host(p_url text)
returns text language sql immutable as $$
  select lower(substring(p_url from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)'))
$$;

-- Совпадение хоста с шаблоном из allowlist: точное или "*.domain"
create or replace function public.host_matches(p_host text, p_pattern text)
returns boolean language sql immutable as $$
  select case
    when p_host is null or p_pattern is null then false
    when left(p_pattern, 2) = '*.' then
      lower(p_host) like '%.' || lower(substring(p_pattern from 3))
    else lower(p_host) = lower(p_pattern)
  end
$$;

create or replace function public.host_allowed(p_host text, p_patterns text[])
returns boolean language sql immutable as $$
  select coalesce(bool_or(public.host_matches(p_host, x)), false) from unnest(p_patterns) as x
$$;

-- ---------------------------------------------------------------------------
-- Профили и роли
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    -- первый пользователь в системе становится администратором
    case when exists (select 1 from public.profiles) then 'viewer'::public.app_role else 'admin'::public.app_role end
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- viewer < qa < admin
create or replace function public.has_role(p_min public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role >= p_min from public.profiles where id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- Запрещённые хосты (production). Стенд не может их разрешить.
-- ---------------------------------------------------------------------------
create table public.forbidden_hosts (
  pattern text primary key,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Стенды
-- ---------------------------------------------------------------------------
create table public.stands (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  env public.stand_env not null,
  base_url text not null check (base_url ~ '^https?://'),
  -- воркер ходит только на эти хосты; остальное блокируется в браузере
  allowed_hosts text[] not null check (cardinality(allowed_hosts) > 0),
  -- перед прогоном воркер проверяет маркер окружения
  health_url text check (health_url is null or health_url ~ '^https?://'),
  expected_env_marker text,
  -- тестовая почта стенда (Mailpit/MailHog API)
  mail_domain text,
  mailbox_api_url text check (mailbox_api_url is null or mailbox_api_url ~ '^https?://'),
  -- служебный API стенда для удаления тестовых записей
  cleanup_api_url text check (cleanup_api_url is null or cleanup_api_url ~ '^https?://'),
  max_concurrency int not null default 2 check (max_concurrency between 1 and 50),
  max_holds int not null default 1 check (max_holds between 0 and 10),
  rps_limit int check (rps_limit is null or rps_limit > 0),
  -- окна, когда плановые прогоны не стартуют: {"tz":"Europe/Moscow","from":"10:00","to":"19:00","days":[1,2,3,4,5]}
  quiet_hours jsonb,
  fixture_ttl_minutes int not null default 120 check (fixture_ttl_minutes between 5 and 10080),
  mocks jsonb not null default '{}'::jsonb,
  test_flags jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger stands_touch before update on public.stands
  for each row execute function public.touch_updated_at();

-- Все URL стенда должны указывать на разрешённые хосты, и ни один хост не может быть запрещённым.
create or replace function public.validate_stand()
returns trigger language plpgsql set search_path = public as $$
declare
  v_url text;
  v_host text;
  v_bad text;
begin
  foreach v_url in array array[new.base_url, new.health_url, new.mailbox_api_url, new.cleanup_api_url] loop
    continue when v_url is null;
    v_host := public.url_host(v_url);
    if not public.host_allowed(v_host, new.allowed_hosts) then
      raise exception 'Хост % (%) не входит в allowed_hosts стенда %', v_host, v_url, new.slug
        using errcode = 'check_violation';
    end if;
  end loop;

  select f.pattern into v_bad
  from public.forbidden_hosts f, unnest(new.allowed_hosts) as a(h)
  where public.host_matches(replace(a.h, '*.', 'x.'), f.pattern)
     or public.host_matches(replace(f.pattern, '*.', 'x.'), a.h)
     or lower(a.h) = lower(f.pattern)
  limit 1;

  if v_bad is not null then
    raise exception 'Стенд % ссылается на запрещённый (production) хост %', new.slug, v_bad
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger stands_validate before insert or update on public.stands
  for each row execute function public.validate_stand();

-- Секреты стенда: значения живут в Supabase Vault, здесь только ссылка.
create table public.stand_secrets (
  id uuid primary key default gen_random_uuid(),
  stand_id uuid not null references public.stands (id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_]{1,60}$'),
  vault_secret_id uuid not null,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  unique (stand_id, name)
);

-- ---------------------------------------------------------------------------
-- Сюиты и расписания
-- ---------------------------------------------------------------------------
create table public.suites (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name text not null,
  description text,
  -- ключи сценариев из реестра воркера (apps/worker/src/scenarios)
  scenario_keys text[] not null check (cardinality(scenario_keys) > 0),
  tags text[] not null default '{}',
  default_parallelism int not null default 1 check (default_parallelism between 1 and 50),
  max_retries int not null default 1 check (max_retries between 0 and 5),
  test_timeout_sec int not null default 180 check (test_timeout_sec between 10 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger suites_touch before update on public.suites
  for each row execute function public.touch_updated_at();

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.suites (id) on delete cascade,
  stand_id uuid not null references public.stands (id) on delete cascade,
  cron text not null,
  timezone text not null default 'Europe/Moscow',
  build_tag text not null default 'latest',
  overlap_policy public.overlap_policy not null default 'skip',
  parallelism int check (parallelism is null or parallelism between 1 and 50),
  enabled boolean not null default true,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger schedules_touch before update on public.schedules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Прогоны
-- ---------------------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  suite_id uuid not null references public.suites (id),
  stand_id uuid not null references public.stands (id),
  build_tag text not null check (length(build_tag) between 1 and 120),
  status public.run_status not null default 'queued',
  trigger public.run_trigger not null default 'manual',
  -- меньше = важнее: webhook 10, manual 50, rerun 40, schedule 100
  priority int not null default 50,
  parallelism int not null default 1 check (parallelism between 1 and 50),
  max_retries int not null default 1 check (max_retries between 0 and 5),
  only_scenarios text[],
  -- при падении шага воркер удерживает сессию для разбора (manual_hold)
  hold_on_failure boolean not null default false,
  idempotency_key text unique,
  parent_run_id uuid references public.runs (id),
  schedule_id uuid references public.schedules (id) on delete set null,
  trace_id uuid not null default gen_random_uuid(),
  created_by uuid references auth.users (id),
  worker_id text,
  cancel_requested boolean not null default false,
  pause_requested boolean not null default false,
  summary jsonb not null default '{}'::jsonb,
  error text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index runs_queue_idx on public.runs (priority, created_at) where status = 'queued';
create index runs_stand_status_idx on public.runs (stand_id, status);
create index runs_created_idx on public.runs (created_at desc);

create table public.run_tests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  scenario_key text not null,
  name text not null,
  status public.test_status not null default 'queued',
  attempt int not null default 0,
  max_attempts int not null default 1,
  flaky boolean not null default false,
  error text,
  error_kind public.error_kind,
  duration_ms int,
  trace_path text,
  video_path text,
  -- manual_hold
  hold_requested boolean not null default false,
  hold_step text,
  hold_until timestamptz,
  hold_action public.hold_action,
  hold_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, scenario_key)
);

create index run_tests_run_idx on public.run_tests (run_id);

create table public.run_steps (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  run_test_id uuid not null references public.run_tests (id) on delete cascade,
  attempt int not null,
  idx int not null,
  name text not null,
  status public.step_status not null default 'running',
  error text,
  screenshot_path text,
  dom_path text,
  network_errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index run_steps_test_idx on public.run_steps (run_test_id, attempt, idx);

create table public.run_logs (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  run_test_id uuid references public.run_tests (id) on delete cascade,
  ts timestamptz not null default now(),
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  data jsonb
);

create index run_logs_run_idx on public.run_logs (run_id, id);

-- ---------------------------------------------------------------------------
-- Фикстуры (синтетические тестовые записи на стендах)
-- ---------------------------------------------------------------------------
create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  stand_id uuid not null references public.stands (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  run_test_id uuid references public.run_tests (id) on delete set null,
  build_tag text,
  kind text not null default 'user',
  -- публичная часть: email, имя, локаль
  payload jsonb not null default '{}'::jsonb,
  -- пароль/токены тестовой записи; не выдаётся роли authenticated (см. grants)
  secret_payload jsonb not null default '{}'::jsonb,
  status public.fixture_status not null default 'created',
  locked_by uuid references public.run_tests (id) on delete set null,
  expires_at timestamptz not null,
  cleanup_attempts int not null default 0,
  last_error text,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger fixtures_touch before update on public.fixtures
  for each row execute function public.touch_updated_at();

create index fixtures_stand_status_idx on public.fixtures (stand_id, status);
create index fixtures_expires_idx on public.fixtures (expires_at) where status not in ('cleaned');
create index fixtures_run_idx on public.fixtures (run_id);

-- ---------------------------------------------------------------------------
-- Аудит
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb,
  at timestamptz not null default now()
);

create index audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit(p_action text, p_entity text, p_entity_id text, p_data jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, action, entity, entity_id, data)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_data)
$$;

create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
begin
  v_row := to_jsonb(coalesce(new, old));
  -- секреты и лишнее в аудит не пишем
  v_row := v_row - 'secret_payload' - 'vault_secret_id';
  insert into public.audit_log (actor, action, entity, entity_id, data)
  values (auth.uid(), lower(tg_op), tg_table_name, v_row ->> 'id', v_row);
  return coalesce(new, old);
end $$;

create trigger stands_audit after insert or update or delete on public.stands
  for each row execute function public.audit_row();
create trigger stand_secrets_audit after insert or update or delete on public.stand_secrets
  for each row execute function public.audit_row();
create trigger suites_audit after insert or update or delete on public.suites
  for each row execute function public.audit_row();
create trigger schedules_audit after insert or update or delete on public.schedules
  for each row execute function public.audit_row();
create trigger forbidden_hosts_audit after insert or update or delete on public.forbidden_hosts
  for each row execute function public.audit_row();
