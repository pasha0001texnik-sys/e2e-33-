-- E2E Hub, этап 3: мобильные стенды (Appium) и передача фикстур между тестами.

-- ---------------------------------------------------------------------------
-- Мобильные стенды
-- ---------------------------------------------------------------------------
create type public.stand_platform as enum ('web', 'android', 'ios');

alter table public.stands
  add column platform public.stand_platform not null default 'web',
  -- Appium-сервер, через который воркер управляет эмулятором/устройством
  add column appium_url text check (appium_url is null or appium_url ~ '^https?://'),
  -- W3C capabilities сессии: appium:app / appium:appPackage, appium:deviceName и т.п.
  add column capabilities jsonb not null default '{}'::jsonb;

alter table public.stands
  add constraint stands_mobile_needs_appium check (platform = 'web' or appium_url is not null);

-- ---------------------------------------------------------------------------
-- Зависимости между тестами и передача данных
-- ---------------------------------------------------------------------------
alter table public.run_tests
  -- ключи сценариев, которые должны пройти раньше этого теста
  add column depends_on text[] not null default '{}',
  -- что тест передаёт зависимым: только id фикстур и несекретные значения
  add column outputs jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Очередь: воркер берёт прогоны только для своих платформ (web / android / ios)
-- ---------------------------------------------------------------------------
drop function public.worker_claim_run(text);

create or replace function public.worker_claim_run(
  p_worker text,
  p_platforms public.stand_platform[] default array['web']::public.stand_platform[]
)
returns public.runs language plpgsql security definer set search_path = public as $$
declare
  v_run public.runs;
  v_stand public.stands;
  v_used int;
  v_eff int;
begin
  for v_run in
    select r.* from public.runs r
    join public.stands s on s.id = r.stand_id
    where r.status = 'queued' and not r.pause_requested and s.platform = any (p_platforms)
    order by r.priority, r.created_at
    for update of r skip locked
  loop
    select * into v_stand from public.stands where id = v_run.stand_id;
    continue when v_stand.id is null or not v_stand.is_active;
    -- плановые прогоны не стартуют в тихие часы стенда
    continue when v_run.trigger = 'schedule' and public.in_quiet_hours(v_stand.quiet_hours);

    -- сериализуем выбор по стенду, чтобы два воркера не превысили лимит
    perform pg_advisory_xact_lock(hashtextextended('stand:' || v_stand.id::text, 0));

    select coalesce(sum(parallelism), 0) into v_used
    from public.runs where stand_id = v_stand.id and status in ('running', 'paused');

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

-- Фикстура, которую передал тест-зависимость того же прогона.
create or replace function public.worker_claim_fixture_by_id(p_fixture uuid, p_run uuid, p_test uuid)
returns public.fixtures language plpgsql security definer set search_path = public as $$
declare
  v_fx public.fixtures;
begin
  select * into v_fx from public.fixtures
  where id = p_fixture and run_id = p_run and locked_by is null
    and status in ('created', 'verified', 'in_use')
  for update skip locked;
  if v_fx.id is null then
    return null;
  end if;
  update public.fixtures set status = 'in_use', locked_by = p_test where id = v_fx.id returning * into v_fx;
  return v_fx;
end $$;

revoke execute on function public.worker_claim_run(text, public.stand_platform[]) from public, anon, authenticated;
revoke execute on function public.worker_claim_fixture_by_id(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.worker_claim_run(text, public.stand_platform[]) to service_role;
grant execute on function public.worker_claim_fixture_by_id(uuid, uuid, uuid) to service_role;
