-- E2E Hub: реестр результатов выполнения сценариев (артефакты прогона).
-- Отдельная сущность на каждое выполнение сценария: поля формы, дамп cookies/storage,
-- сетевой профиль, регион, статус и ошибка. Запись ведёт воркер (service_role).

create table public.run_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  run_test_id uuid not null references public.run_tests (id) on delete cascade,
  scenario_key text not null,
  status public.test_status not null,
  -- сгенерированные поля формы; секреты маскируются при записи (см. воркер)
  form_fields jsonb not null default '{}'::jsonb,
  -- сетевой профиль: { "download": 1_000_000, "latency": 40, "offline": false, "user_agent": "…" }
  network_profile jsonb not null default '{}'::jsonb,
  region text,
  error text,
  -- дамп cookies/localStorage: содержит session-секреты, наружу не выдаётся
  storage_dump jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- один результат на выполнение сценария; повтор попытки перезаписывает
  unique (run_test_id)
);

create index run_results_run_idx on public.run_results (run_id);
create index run_results_status_idx on public.run_results (status);
create index run_results_created_idx on public.run_results (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS и права: читают все вошедшие (кроме storage_dump), пишет только воркер
-- ---------------------------------------------------------------------------
alter table public.run_results enable row level security;

create policy run_results_read on public.run_results for select to authenticated using (true);

revoke select, insert, update, delete on public.run_results from authenticated, anon;
grant select (id, run_id, run_test_id, scenario_key, status, form_fields, network_profile, region, error, created_at)
  on public.run_results to authenticated;

-- ---------------------------------------------------------------------------
-- Запись результата (только service_role). Перезаписывает при повторной попытке.
-- ---------------------------------------------------------------------------
create or replace function public.worker_record_result(
  p_run uuid,
  p_test uuid,
  p_scenario text,
  p_status public.test_status,
  p_form_fields jsonb default '{}'::jsonb,
  p_network_profile jsonb default '{}'::jsonb,
  p_region text default null,
  p_error text default null,
  p_storage_dump jsonb default '{}'::jsonb
)
returns public.run_results language plpgsql security definer set search_path = public as $$
declare
  v_row public.run_results;
begin
  insert into public.run_results (run_id, run_test_id, scenario_key, status, form_fields, network_profile, region, error, storage_dump)
  values (p_run, p_test, p_scenario, p_status, coalesce(p_form_fields, '{}'::jsonb), coalesce(p_network_profile, '{}'::jsonb), p_region, p_error, coalesce(p_storage_dump, '{}'::jsonb))
  on conflict (run_test_id) do update set
    status = excluded.status,
    form_fields = excluded.form_fields,
    network_profile = excluded.network_profile,
    region = excluded.region,
    error = excluded.error,
    storage_dump = excluded.storage_dump,
    created_at = now()
  returning * into v_row;
  return v_row;
end $$;

revoke execute on function public.worker_record_result(uuid, uuid, text, public.test_status, jsonb, jsonb, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.worker_record_result(uuid, uuid, text, public.test_status, jsonb, jsonb, text, text, jsonb) to service_role;

-- Realtime: реестр обновляется вживую
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.run_results;
  end if;
end $$;
