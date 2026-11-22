-- E2E Hub: RLS, права, RPC оркестратора, очередь, Vault, Realtime, Storage.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.forbidden_hosts enable row level security;
alter table public.stands enable row level security;
alter table public.stand_secrets enable row level security;
alter table public.suites enable row level security;
alter table public.schedules enable row level security;
alter table public.runs enable row level security;
alter table public.run_tests enable row level security;
alter table public.run_steps enable row level security;
alter table public.run_logs enable row level security;
alter table public.fixtures enable row level security;
alter table public.audit_log enable row level security;

-- Профили: каждый видит себя, админ видит всех. Роль меняется только через set_user_role.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('admin'));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Справочники: читают все вошедшие, пишет админ.
create policy forbidden_hosts_read on public.forbidden_hosts for select to authenticated using (true);
create policy forbidden_hosts_write on public.forbidden_hosts for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy stands_read on public.stands for select to authenticated using (true);
create policy stands_write on public.stands for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Ссылки на секреты видит админ; значения недоступны никому, кроме service_role.
create policy stand_secrets_read on public.stand_secrets for select to authenticated
  using (public.has_role('admin'));

create policy suites_read on public.suites for select to authenticated using (true);
create policy suites_write on public.suites for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy schedules_read on public.schedules for select to authenticated using (true);
create policy schedules_write on public.schedules for all to authenticated
  using (public.has_role('qa')) with check (public.has_role('qa'));

-- Прогоны: читают все; создаёт QA вручную от своего имени; остальное — через RPC.
create policy runs_read on public.runs for select to authenticated using (true);
create policy runs_insert on public.runs for insert to authenticated
  with check (
    public.has_role('qa')
    and created_by = auth.uid()
    and trigger = 'manual'
    and status = 'queued'
    and parent_run_id is null
  );
revoke update, delete on public.runs from authenticated;
-- клиент не может задать служебные поля
revoke insert on public.runs from authenticated;
grant insert (suite_id, stand_id, build_tag, parallelism, max_retries, only_scenarios, hold_on_failure, created_by, trigger, status)
  on public.runs to authenticated;

create policy run_tests_read on public.run_tests for select to authenticated using (true);
create policy run_steps_read on public.run_steps for select to authenticated using (true);
create policy run_logs_read on public.run_logs for select to authenticated using (true);
revoke insert, update, delete on public.run_tests, public.run_steps, public.run_logs from authenticated;

-- Фикстуры: читают все, но без secret_payload.
create policy fixtures_read on public.fixtures for select to authenticated using (true);
revoke select, insert, update, delete on public.fixtures from authenticated, anon;
grant select (id, stand_id, run_id, run_test_id, build_tag, kind, payload, status, locked_by, expires_at,
              cleanup_attempts, last_error, cleaned_at, created_at, updated_at)
  on public.fixtures to authenticated;

create policy audit_read on public.audit_log for select to authenticated using (public.has_role('admin'));
revoke insert, update, delete on public.audit_log from authenticated;

-- anon ничего не видит
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Пользователи
-- ---------------------------------------------------------------------------
create or replace function public.set_user_role(p_user uuid, p_role public.app_role)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then
    raise exception 'Только администратор может менять роли' using errcode = '42501';
  end if;
  if p_user = auth.uid() and p_role <> 'admin' then
    raise exception 'Нельзя понизить собственную роль' using errcode = '42501';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public.audit('set_role', 'profiles', p_user::text, jsonb_build_object('role', p_role));
end $$;

-- ---------------------------------------------------------------------------
-- Секреты стендов (Supabase Vault). Значение write-only.
-- ---------------------------------------------------------------------------
create extension if not exists supabase_vault with schema vault;

create or replace function public.set_stand_secret(p_stand uuid, p_name text, p_value text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare
  v_existing uuid;
  v_secret uuid;
  v_vault_name text := 'stand:' || p_stand::text || ':' || p_name;
begin
  if not public.has_role('admin') then
    raise exception 'Только администратор управляет секретами' using errcode = '42501';
  end if;
  if coalesce(length(p_value), 0) = 0 then
    raise exception 'Пустое значение секрета';
  end if;

  select vault_secret_id into v_existing from public.stand_secrets where stand_id = p_stand and name = p_name;

  if v_existing is null then
    v_secret := vault.create_secret(p_value, v_vault_name, 'E2E Hub stand secret');
    insert into public.stand_secrets (stand_id, name, vault_secret_id, updated_by)
    values (p_stand, p_name, v_secret, auth.uid());
  else
    perform vault.update_secret(v_existing, p_value, v_vault_name, 'E2E Hub stand secret');
    update public.stand_secrets set updated_by = auth.uid(), updated_at = now()
    where stand_id = p_stand and name = p_name;
    v_secret := v_existing;
  end if;
  return v_secret;
end $$;

create or replace function public.delete_stand_secret(p_stand uuid, p_name text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare
  v_id uuid;
begin
  if not public.has_role('admin') then
    raise exception 'Только администратор управляет секретами' using errcode = '42501';
  end if;
  delete from public.stand_secrets where stand_id = p_stand and name = p_name returning vault_secret_id into v_id;
  if v_id is not null then
    delete from vault.secrets where id = v_id;
  end if;
end $$;

-- Только для воркера (service_role).
create or replace function public.worker_get_stand_secrets(p_stand uuid)
returns table (name text, value text) language sql security definer set search_path = public, vault as $$
  select s.name, d.decrypted_secret
  from public.stand_secrets s
  join vault.decrypted_secrets d on d.id = s.vault_secret_id
  where s.stand_id = p_stand
$$;

-- ---------------------------------------------------------------------------
-- Управление прогонами (UI)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_run(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  -- ещё не взятый в работу прогон отменяется сразу
  update public.runs set status = 'cancelled', finished_at = now(), cancel_requested = true
  where id = p_run and status = 'queued';
  if not found then
    update public.runs set cancel_requested = true
    where id = p_run and status in ('running', 'paused');
  end if;
  perform public.audit('cancel', 'runs', p_run::text);
end $$;

-- Пауза: воркер перестаёт выдавать новые тесты; идущие тесты доходят до конца.
create or replace function public.set_run_paused(p_run uuid, p_paused boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.runs set pause_requested = p_paused
  where id = p_run and status in ('queued', 'running', 'paused');
  perform public.audit(case when p_paused then 'pause' else 'resume' end, 'runs', p_run::text);
end $$;

-- Перезапуск упавших тестов целиком (не шагов), со свежими фикстурами.
create or replace function public.rerun_failed(p_run uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_src public.runs;
  v_keys text[];
  v_new uuid;
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  select * into v_src from public.runs where id = p_run;
  if v_src.id is null then
    raise exception 'Прогон не найден';
  end if;
  select array_agg(scenario_key order by scenario_key) into v_keys
  from public.run_tests where run_id = p_run and status in ('failed', 'cancelled', 'skipped');
  if v_keys is null then
    raise exception 'В прогоне нет упавших тестов';
  end if;

  insert into public.runs (suite_id, stand_id, build_tag, trigger, priority, parallelism, max_retries,
                           only_scenarios, parent_run_id, created_by)
  values (v_src.suite_id, v_src.stand_id, v_src.build_tag, 'rerun', 40, v_src.parallelism, v_src.max_retries,
          v_keys, v_src.id, auth.uid())
  returning id into v_new;

  perform public.audit('rerun_failed', 'runs', p_run::text, jsonb_build_object('new_run', v_new, 'tests', v_keys));
  return v_new;
end $$;

-- Ответ QA-инженера на manual_hold.
create or replace function public.respond_hold(p_test uuid, p_action public.hold_action)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.run_tests set hold_action = p_action, hold_by = auth.uid()
  where id = p_test and status = 'on_hold';
  if not found then
    raise exception 'Тест не находится в режиме ожидания';
  end if;
  perform public.audit('hold_' || p_action::text, 'run_tests', p_test::text);
end $$;

-- Запросить hold на следующем шаге идущего теста.
create or replace function public.request_hold(p_test uuid, p_requested boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.run_tests set hold_requested = p_requested
  where id = p_test and status in ('queued', 'running');
end $$;

-- Ручная очистка фикстур.
create or replace function public.request_fixture_cleanup(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if not public.has_role('qa') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.fixtures set status = 'cleanup_pending'
  where id = any (p_ids) and status not in ('cleaned', 'in_use');
  get diagnostics v_count = row_count;
  perform public.audit('cleanup_request', 'fixtures', null, jsonb_build_object('ids', p_ids));
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Очередь (для воркера). Учитывает лимит потоков стенда и тихие часы.
-- ---------------------------------------------------------------------------
create or replace function public.in_quiet_hours(p_quiet jsonb, p_at timestamptz default now())
returns boolean language plpgsql stable as $$
declare
  v_local timestamp;
  v_from time;
  v_to time;
  v_t time;
  v_days int[];
begin
  if p_quiet is null or p_quiet ->> 'from' is null or p_quiet ->> 'to' is null then
    return false;
  end if;
  v_local := p_at at time zone coalesce(p_quiet ->> 'tz', 'UTC');
  v_from := (p_quiet ->> 'from')::time;
  v_to := (p_quiet ->> 'to')::time;
  v_t := v_local::time;
  if p_quiet ? 'days' then
    select array_agg(x::int) into v_days from jsonb_array_elements_text(p_quiet -> 'days') x;
    if not (extract(isodow from v_local)::int = any (v_days)) then
      return false;
    end if;
  end if;
  if v_from <= v_to then
    return v_t >= v_from and v_t < v_to;
  end if;
  return v_t >= v_from or v_t < v_to; -- окно через полночь
end $$;

create or replace function public.worker_claim_run(p_worker text)
returns public.runs language plpgsql security definer set search_path = public as $$
declare
  v_run public.runs;
  v_stand public.stands;
  v_used int;
  v_eff int;
begin
  for v_run in
    select r.* from public.runs r
    where r.status = 'queued' and not r.pause_requested
    order by r.priority, r.created_at
    for update skip locked
  loop
    select * into v_stand from public.stands where id = v_run.stand_id;
    continue when v_stand.id is null or not v_stand.is_active;
    -- плановые прогоны не стартуют в тихие часы стенда
    continue when v_run.trigger = 'schedule' and public.in_quiet_hours(v_stand.quiet_hours);

    -- сериализуем выбор по стенду, чтобы два воркера не превысили лимит
    perform pg_advisory_xact_lock(hashtextextended('stand:' || v_stand.id::text, 0));

    select coalesce(sum(parallelism), 0) into v_used
    from public.runs where stand_id = v_stand.id and status in ('running', 'paused');

    -- стартуем с тем числом потоков, которое свободно на стенде (не больше запрошенного)
    v_eff := least(v_run.parallelism, v_stand.max_concurrency - v_used);
    continue when v_eff < 1;

    update public.runs
    set status = 'running', worker_id = p_worker, started_at = now(), heartbeat_at = now(), parallelism = v_eff
    where id = v_run.id
    returning * into v_run;
    return v_run;
  end loop;
  return null;
end $$;

-- Атомарный захват свободной фикстуры (для сценариев, которым нужна готовая запись).
create or replace function public.worker_claim_fixture(p_stand uuid, p_kind text, p_test uuid)
returns public.fixtures language plpgsql security definer set search_path = public as $$
declare
  v_fx public.fixtures;
begin
  select * into v_fx from public.fixtures
  where stand_id = p_stand and kind = p_kind and status = 'verified' and locked_by is null and expires_at > now() + interval '5 minutes'
  order by created_at
  for update skip locked
  limit 1;
  if v_fx.id is null then
    return null;
  end if;
  update public.fixtures set status = 'in_use', locked_by = p_test where id = v_fx.id returning * into v_fx;
  return v_fx;
end $$;

-- Уборщик: истёкшие фикстуры и зависшие прогоны.
create or replace function public.worker_janitor(p_stale_after interval default interval '5 minutes')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_stale int;
  v_expired int;
  v_orphaned int;
begin
  -- прогоны без heartbeat считаем умершими
  with stale as (
    update public.runs set status = 'error', finished_at = now(), error = 'Воркер перестал отвечать (heartbeat timeout)'
    where status in ('running', 'paused') and heartbeat_at < now() - p_stale_after
    returning id
  )
  select count(*) into v_stale from stale;

  update public.run_tests t set status = 'cancelled', finished_at = now(), error = coalesce(t.error, 'Прогон прерван')
  from public.runs r
  where t.run_id = r.id and r.status = 'error' and t.status in ('queued', 'running', 'on_hold');

  -- фикстуры умерших прогонов
  with o as (
    update public.fixtures f set status = 'orphaned', locked_by = null
    from public.runs r
    where f.run_id = r.id and r.status in ('error', 'cancelled')
      and f.status in ('created', 'verified', 'in_use')
    returning f.id
  )
  select count(*) into v_orphaned from o;

  -- всё, что истекло по TTL или осиротело, — в очередь на очистку
  with e as (
    update public.fixtures set status = 'cleanup_pending', locked_by = null
    where (expires_at < now() and status in ('created', 'verified', 'in_use', 'failed') and cleanup_attempts < 5)
       or status = 'orphaned'
    returning id
  )
  select count(*) into v_expired from e;

  return jsonb_build_object('stale_runs', v_stale, 'orphaned_fixtures', v_orphaned, 'queued_for_cleanup', v_expired);
end $$;

-- ---------------------------------------------------------------------------
-- Права на функции
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;

grant execute on function public.my_role() to authenticated;
grant execute on function public.has_role(public.app_role) to authenticated;
grant execute on function public.url_host(text) to authenticated;
grant execute on function public.host_matches(text, text) to authenticated;
grant execute on function public.host_allowed(text, text[]) to authenticated;
grant execute on function public.in_quiet_hours(jsonb, timestamptz) to authenticated;
grant execute on function public.set_user_role(uuid, public.app_role) to authenticated;
grant execute on function public.set_stand_secret(uuid, text, text) to authenticated;
grant execute on function public.delete_stand_secret(uuid, text) to authenticated;
grant execute on function public.cancel_run(uuid) to authenticated;
grant execute on function public.set_run_paused(uuid, boolean) to authenticated;
grant execute on function public.rerun_failed(uuid) to authenticated;
grant execute on function public.respond_hold(uuid, public.hold_action) to authenticated;
grant execute on function public.request_hold(uuid, boolean) to authenticated;
grant execute on function public.request_fixture_cleanup(uuid[]) to authenticated;

-- функции воркера — только service_role
revoke execute on function public.worker_get_stand_secrets(uuid) from authenticated;
revoke execute on function public.worker_claim_run(text) from authenticated;
revoke execute on function public.worker_claim_fixture(uuid, text, uuid) from authenticated;
revoke execute on function public.worker_janitor(interval) from authenticated;
grant execute on function public.worker_get_stand_secrets(uuid) to service_role;
grant execute on function public.worker_claim_run(text) to service_role;
grant execute on function public.worker_claim_fixture(uuid, text, uuid) to service_role;
grant execute on function public.worker_janitor(interval) to service_role;

-- триггерные и служебные функции наружу не нужны
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.audit(text, text, text, jsonb) from authenticated;
revoke execute on function public.audit_row() from authenticated;
revoke execute on function public.validate_stand() from authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: живые статусы и лог
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.runs, public.run_tests, public.run_steps, public.run_logs;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: приватный бакет артефактов (скриншоты, DOM, трейсы)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('artifacts', 'artifacts', false, 104857600)
on conflict (id) do nothing;

create policy artifacts_read on storage.objects for select to authenticated
  using (bucket_id = 'artifacts');
