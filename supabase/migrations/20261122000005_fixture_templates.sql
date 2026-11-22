-- E2E Hub: шаблон генерации тестовых данных в конфигурации прогона.
-- Сам каталог шаблонов (локали, возраст, политика пароля) живёт в коде
-- (@e2e/shared/templates); в БД хранится только выбранный ключ.

alter table public.runs add column fixture_template text;

-- Клиент (QA) может задать шаблон при создании прогона
grant insert (fixture_template) on public.runs to authenticated;
