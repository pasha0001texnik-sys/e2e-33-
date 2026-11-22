-- Демо-данные для локальной разработки (supabase db reset).
-- Замените хосты на свои тестовые стенды.

insert into public.forbidden_hosts (pattern, note) values
  ('example.com', 'production: основной домен'),
  ('www.example.com', 'production: сайт'),
  ('api.example.com', 'production: API')
on conflict do nothing;

insert into public.stands (slug, name, env, base_url, allowed_hosts, health_url, expected_env_marker,
                           mail_domain, mailbox_api_url, cleanup_api_url, max_concurrency, quiet_hours)
values
  ('dev', 'Dev', 'dev', 'https://dev.example.test',
   array['dev.example.test', '*.dev.example.test'],
   'https://dev.example.test/health', 'dev',
   'mail.dev.example.test', 'https://mailpit.dev.example.test', 'https://dev.example.test/__test__/cleanup',
   4, null),
  ('qa', 'QA', 'qa', 'https://qa.example.test',
   array['qa.example.test', '*.qa.example.test'],
   'https://qa.example.test/health', 'qa',
   'mail.qa.example.test', 'https://mailpit.qa.example.test', 'https://qa.example.test/__test__/cleanup',
   2, '{"tz":"Europe/Moscow","from":"10:00","to":"19:00","days":[1,2,3,4,5]}'),
  ('staging', 'Staging', 'staging', 'https://staging.example.test',
   array['staging.example.test', '*.staging.example.test'],
   'https://staging.example.test/health', 'staging',
   'mail.staging.example.test', 'https://mailpit.staging.example.test', 'https://staging.example.test/__test__/cleanup',
   2, '{"tz":"Europe/Moscow","from":"10:00","to":"19:00","days":[1,2,3,4,5]}')
on conflict (slug) do nothing;

insert into public.suites (slug, name, description, scenario_keys, tags, default_parallelism, max_retries)
values
  ('smoke-auth', 'Smoke: регистрация и вход', 'Быстрая проверка перед выкаткой',
   array['signup.email', 'login.password'], array['smoke', 'auth'], 2, 1),
  ('onboarding-full', 'Онбординг целиком', 'Регистрация, подтверждение почты, анкета онбординга',
   array['signup.email', 'signup.verify-email', 'onboarding.profile', 'login.password', 'login.wrong-password'],
   array['regression', 'onboarding'], 3, 1)
on conflict (slug) do nothing;
