-- E2E Hub: профиль гео- и сетевой эмуляции прогона.
-- Каталог профилей (none / offline / slow-3g / fast-3g / geo-*) живёт в коде
-- (@e2e/shared netprofile); в БД хранится только выбранный ключ.
-- Эмуляция применяется только в контексте браузера воркера (координаты,
-- разрешение геолокации, троттлинг/offline). Трафик наружу не маршрутизируется —
-- allowlist и сетевой guard остаются в силе.
-- Дефолт стенда задаётся ключом test_flags.net_profile; прогон его переопределяет.

alter table public.runs add column net_profile text;

grant insert (net_profile) on public.runs to authenticated;
