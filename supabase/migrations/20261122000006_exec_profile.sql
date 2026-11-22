-- E2E Hub: профиль выполнения прогона (тайминги шагов и политика повторов).
-- Каталог профилей (instant / human / stable) живёт в коде (@e2e/shared timings);
-- в БД хранится только выбранный ключ.

alter table public.runs add column exec_profile text;

grant insert (exec_profile) on public.runs to authenticated;
