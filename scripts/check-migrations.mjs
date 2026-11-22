// Проверка миграций без Docker: PGlite (Postgres в WASM) + заглушки схем Supabase.
// Запуск: pnpm db:check
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const migDir = join(root, "supabase", "migrations");

const SUPABASE_STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(s text, n text, d text) returns uuid language sql as
  $$ insert into vault.secrets (secret, name, description) values (s, n, d) returning id $$;
create function vault.update_secret(i uuid, s text, n text, d text) returns void language sql as
  $$ update vault.secrets set secret = s, name = n, description = d where id = i $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create publication supabase_realtime;
grant usage on schema public, auth to anon, authenticated, service_role;
-- как в Supabase: новые объекты public по умолчанию доступны anon/authenticated/service_role
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const db = new PGlite();
await db.exec(SUPABASE_STUBS);

for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
  let sql = readFileSync(join(migDir, f), "utf8");
  sql = sql.replace(/create extension if not exists [^;]+;/gi, "");
  try {
    await db.exec(sql);
    console.log(`✓ ${f}`);
  } catch (e) {
    console.error(`✗ ${f}: ${e.message}`);
    process.exit(1);
  }
}
await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));
console.log("✓ seed.sql");

const one = async (q, p) => (await db.query(q, p)).rows[0];
const as = (uid) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
const expectError = async (q, re, p) => {
  try {
    await db.query(q, p);
  } catch (e) {
    assert.match(e.message, re);
    return;
  }
  throw new Error(`Ожидалась ошибка ${re} для: ${q}`);
};

// первый пользователь — admin, второй — viewer
const admin = (await one(`insert into auth.users (email) values ('admin@x.test') returning id`)).id;
const viewer = (await one(`insert into auth.users (email) values ('v@x.test') returning id`)).id;
assert.equal((await one(`select role from profiles where id = $1`, [admin])).role, "admin");
assert.equal((await one(`select role from profiles where id = $1`, [viewer])).role, "viewer");
console.log("✓ первый пользователь становится admin");

// защита от production
await expectError(
  `insert into stands (slug, name, env, base_url, allowed_hosts) values ('bad', 'Bad', 'qa', 'https://evil.test', array['qa.example.test'])`,
  /не входит в allowed_hosts/,
);
await expectError(
  `insert into stands (slug, name, env, base_url, allowed_hosts) values ('prod', 'Prod', 'qa', 'https://api.example.com', array['api.example.com'])`,
  /запрещённый/,
);
await expectError(
  `insert into stands (slug, name, env, base_url, allowed_hosts) values ('prod2', 'Prod', 'qa', 'https://x.example.com', array['*.example.com'])`,
  /запрещённый/,
);
await expectError(
  `insert into stands (slug, name, env, base_url, allowed_hosts) values ('p3', 'P', 'production', 'https://qa.example.test', array['qa.example.test'])`,
  /invalid input value for enum/,
);
console.log("✓ стенд не может указывать на production или чужой хост");

// тихие часы
assert.equal((await one(`select in_quiet_hours('{"tz":"UTC","from":"10:00","to":"19:00"}', '2026-11-20 12:00Z') v`)).v, true);
assert.equal((await one(`select in_quiet_hours('{"tz":"UTC","from":"10:00","to":"19:00"}', '2026-11-20 20:00Z') v`)).v, false);
assert.equal((await one(`select in_quiet_hours('{"tz":"UTC","from":"22:00","to":"06:00"}', '2026-11-20 23:00Z') v`)).v, true);
assert.equal((await one(`select in_quiet_hours('{"tz":"UTC","from":"10:00","to":"19:00","days":[6,7]}', '2026-11-20 12:00Z') v`)).v, false);
console.log("✓ тихие часы");

// лимит потоков стенда: qa max_concurrency = 2
const qa = (await one(`select id from stands where slug = 'qa'`)).id;
const suite = (await one(`select id from suites where slug = 'smoke-auth'`)).id;
for (const [p, prio] of [[2, 50], [1, 10], [5, 60]]) {
  await db.query(`insert into runs (suite_id, stand_id, build_tag, parallelism, priority) values ($1, $2, 'b1', $3, $4)`, [suite, qa, p, prio]);
}
const r1 = await one(`select * from worker_claim_run('w1')`);
assert.equal(r1.priority, 10, "сначала самый приоритетный");
const r2 = await one(`select * from worker_claim_run('w1')`);
assert.equal(r2.priority, 50, "следующий по приоритету");
assert.equal(r2.parallelism, 1, "потоки урезаны до свободного места на стенде");
const r3 = await one(`select * from worker_claim_run('w1')`);
assert.equal(r3.id, null, "лимит стенда исчерпан");
console.log("✓ очередь: приоритет и лимит потоков стенда");

// RLS: viewer не может создать прогон, admin может
await db.exec(`set role authenticated`);
await as(viewer);
await expectError(
  `insert into runs (suite_id, stand_id, build_tag, created_by, trigger, status) values ($1, $2, 'b', $3, 'manual', 'queued')`,
  /row-level security/,
  [suite, qa, viewer],
);
await expectError(`select secret_payload from fixtures`, /permission denied/);
await expectError(`select * from worker_claim_run('x')`, /permission denied/);
await as(admin);
await db.query(
  `insert into runs (suite_id, stand_id, build_tag, created_by, trigger, status) values ($1, $2, 'b', $3, 'manual', 'queued')`,
  [suite, qa, admin],
);
await expectError(
  `insert into runs (suite_id, stand_id, build_tag, created_by, priority) values ($1, $2, 'b', $3, 1)`,
  /permission denied/,
  [suite, qa, admin],
);
const secretId = (await one(`select set_stand_secret($1, 'cleanup_token', 's3cr3t') v`, [qa])).v;
assert.ok(secretId);
await db.exec(`reset role`);
await as(null);
assert.equal((await one(`select value from worker_get_stand_secrets($1)`, [qa])).value, "s3cr3t");
const auditData = (await one(`select data from audit_log where entity = 'stand_secrets' order by id desc limit 1`)).data;
assert.equal(auditData.vault_secret_id, undefined, "ссылка на секрет не попадает в аудит");
console.log("✓ RLS, права и секреты в Vault");

// уборщик: зависший прогон -> error, его фикстуры -> очистка
await db.query(`update runs set heartbeat_at = now() - interval '10 minutes' where id = $1`, [r1.id]);
await db.query(
  `insert into fixtures (stand_id, run_id, payload, status, expires_at) values ($1, $2, '{}', 'in_use', now() + interval '1 hour')`,
  [qa, r1.id],
);
await db.query(`insert into fixtures (stand_id, payload, status, expires_at) values ($1, '{}', 'verified', now() - interval '1 minute')`, [qa]);
const jan = (await one(`select worker_janitor() v`)).v;
assert.equal(jan.stale_runs, 1);
assert.equal(jan.queued_for_cleanup, 2);
assert.equal((await one(`select status from runs where id = $1`, [r1.id])).status, "error");
console.log("✓ уборщик: зависшие прогоны и истёкшие фикстуры");

// ------------------------------------------------------------------ RPC и права из UI
await db.exec(`set role authenticated`);
await as(viewer);
await expectError(`insert into stands (slug, name, env, base_url, allowed_hosts) values ('v1', 'V', 'qa', 'https://v.example.test', array['v.example.test'])`, /row-level security/);
await expectError(`select set_user_role($1, 'admin')`, /Только администратор/, [viewer]);
await expectError(`select cancel_run($1)`, /Недостаточно прав/, [r2.id]);
await expectError(`select set_stand_secret($1, 'x_token', 'v')`, /Только администратор/, [qa]);
const viewerSecrets = await db.query(`select * from stand_secrets`);
assert.equal(viewerSecrets.rows.length, 0, "наблюдатель не видит даже имена секретов");

await as(admin);
await db.query(`insert into stands (slug, name, env, base_url, allowed_hosts) values ('adm', 'Adm', 'dev', 'https://adm.example.test', array['adm.example.test'])`);
await db.query(`update stands set max_concurrency = 3 where slug = 'adm'`);
await expectError(`update stands set base_url = 'https://other.test' where slug = 'adm'`, /allowed_hosts/);
await db.query(`select set_user_role($1, 'qa')`, [viewer]);
await expectError(`select set_user_role($1, 'viewer')`, /собственную роль/, [admin]);

// QA: отмена, пауза, hold, перезапуск упавших
await as(viewer); // теперь qa
await db.query(`select cancel_run($1)`, [r2.id]);
await db.query(`select set_run_paused($1, true)`, [r2.id]);
await db.exec(`reset role`);
await as(null);
const failedRun = (await one(`insert into runs (suite_id, stand_id, build_tag, status) values ($1, $2, 'b9', 'failed') returning id`, [suite, qa])).id;
await db.query(`insert into run_tests (run_id, scenario_key, name, status) values ($1, 'signup.email', 'a', 'passed'), ($1, 'login.password', 'b', 'failed')`, [failedRun]);
const holdTest = (await one(`insert into run_tests (run_id, scenario_key, name, status) values ($1, 'onboarding.profile', 'c', 'on_hold') returning id`, [failedRun])).id;
await db.exec(`set role authenticated`);
await as(viewer);
await db.query(`select respond_hold($1, 'continue')`, [holdTest]);
const newRun = (await one(`select rerun_failed($1) v`, [failedRun])).v;
await db.exec(`reset role`);
await as(null);
const nr = await one(`select trigger, only_scenarios, parent_run_id, priority from runs where id = $1`, [newRun]);
assert.equal(nr.trigger, "rerun");
assert.deepEqual(nr.only_scenarios, ["login.password"]);
assert.equal(nr.parent_run_id, failedRun);
assert.equal((await one(`select hold_action from run_tests where id = $1`, [holdTest])).hold_action, "continue");
assert.equal((await one(`select cancel_requested from runs where id = $1`, [r2.id])).cancel_requested, true);
assert.ok((await one(`select count(*)::int c from audit_log where action in ('cancel', 'rerun_failed', 'set_role', 'hold_continue')`)).c >= 4);
console.log("✓ RPC из UI: роли, отмена, пауза, hold, перезапуск упавших, аудит");

// захват фикстуры атомарный: вторая попытка не получает ту же запись
const fx = (await one(`insert into fixtures (stand_id, kind, payload, status, expires_at) values ($1, 'user', '{}', 'verified', now() + interval '1 hour') returning id`, [qa])).id;
const c1 = await one(`select * from worker_claim_fixture($1, 'user', $2)`, [qa, holdTest]);
const c2 = await one(`select * from worker_claim_fixture($1, 'user', $2)`, [qa, holdTest]);
assert.equal(c1.id, fx);
assert.equal(c2.id, null);
console.log("✓ фикстура захватывается одним тестом");

// anon (без входа) не видит ничего и не вызывает функции
await db.exec(`set role anon`);
await expectError(`select * from runs`, /permission denied/);
await expectError(`select * from stands`, /permission denied/);
await expectError(`select worker_claim_run('x')`, /permission denied/);
await expectError(`select cancel_run(gen_random_uuid())`, /permission denied/);
await db.exec(`reset role`);
// service_role (воркер) читает пароли фикстур
await db.exec(`set role service_role`);
await db.query(`select secret_payload from fixtures limit 1`);
await db.exec(`reset role`);
console.log("✓ anon без доступа, service_role видит секреты фикстур");

// ------------------------------------------------------------------ этап 3
await expectError(
  `insert into stands (slug, name, env, platform, base_url, allowed_hosts) values ('and0', 'A', 'qa', 'android', 'https://m.example.test', array['m.example.test'])`,
  /stands_mobile_needs_appium/,
);
const android = (await one(
  `insert into stands (slug, name, env, platform, base_url, allowed_hosts, appium_url, capabilities, max_concurrency)
   values ('and1', 'Android QA', 'qa', 'android', 'https://m.example.test', array['m.example.test'], 'http://appium:4723', '{"appium:deviceName":"emulator-5554"}', 1)
   returning id`,
)).id;
const mobRun = (await one(`insert into runs (suite_id, stand_id, build_tag, priority) values ($1, $2, 'm1', 1) returning id`, [suite, android])).id;
for (let i = 0; i < 20; i++) {
  const got = (await one(`select * from worker_claim_run('web-worker')`)).id;
  assert.notEqual(got, mobRun, "web-воркер не берёт мобильный прогон");
  if (!got) break;
}
assert.equal((await one(`select * from worker_claim_run('mob', array['android']::stand_platform[])`)).id, mobRun);
console.log("✓ мобильные стенды: Appium обязателен, очередь по платформам");

const depFx = (await one(
  `insert into fixtures (stand_id, run_id, kind, payload, status, expires_at) values ($1, $2, 'user', '{}', 'verified', now() + interval '1 hour') returning id`,
  [android, mobRun],
)).id;
const t1 = (await one(`insert into run_tests (run_id, scenario_key, name, depends_on) values ($1, 'a', 'a', '{}') returning id`, [mobRun])).id;
const t2 = (await one(`insert into run_tests (run_id, scenario_key, name, depends_on) values ($1, 'b', 'b', '{a}') returning id`, [mobRun])).id;
assert.equal((await one(`select * from worker_claim_fixture_by_id($1, $2, $3)`, [depFx, failedRun, t2])).id, null, "чужой прогон не может взять фикстуру");
assert.equal((await one(`select * from worker_claim_fixture_by_id($1, $2, $3)`, [depFx, mobRun, t2])).id, depFx);
assert.equal((await one(`select * from worker_claim_fixture_by_id($1, $2, $3)`, [depFx, mobRun, t1])).id, null, "занятая фикстура не выдаётся второй раз");
await db.exec(`set role authenticated`);
await as(admin);
await expectError(`select worker_claim_fixture_by_id(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, /permission denied/);
await expectError(`select worker_claim_run('x', array['web']::stand_platform[])`, /permission denied/);
await db.exec(`reset role`);
await as(null);
console.log("✓ передача фикстур между тестами одного прогона");

// ------------------------------------------------------------------ run_results
// запись результата доступна только воркеру (service_role)
await db.exec(`set role authenticated`);
await as(admin);
await expectError(`select worker_record_result($1, $2, 'signup.email', 'passed')`, /permission denied/, [mobRun, t1]);
await expectError(`select storage_dump from run_results`, /permission denied|does not exist/);
await db.exec(`reset role`);
await as(null);

await db.query(
  `select worker_record_result($1, $2, 'signup.email', 'passed', '{"email":"e2e@mail.test","password":"x"}'::jsonb, '{"latency":40}'::jsonb, 'eu', null, '{"cookies":[{"name":"sid","value":"secret"}]}'::jsonb)`,
  [mobRun, t1],
);
const rr = await one(`select scenario_key, status, form_fields, network_profile, region from run_results where run_test_id = $1`, [t1]);
assert.equal(rr.status, "passed");
assert.equal(rr.region, "eu");
assert.equal(rr.network_profile.latency, 40);

// service_role читает дамп cookies/storage
await db.exec(`set role service_role`);
assert.ok((await one(`select storage_dump from run_results where run_test_id = $1`, [t1])).storage_dump.cookies, "воркер читает дамп");
await db.exec(`reset role`);

// authenticated видит метаданные, но не storage_dump
await db.exec(`set role authenticated`);
await as(admin);
assert.equal((await one(`select status from run_results where run_test_id = $1`, [t1])).status, "passed", "наблюдатель/админ видит результат");
await expectError(`select storage_dump from run_results where run_test_id = $1`, /permission denied/, [t1]);
await db.exec(`reset role`);
await as(null);

// повтор попытки перезаписывает тот же результат (unique по run_test_id)
await db.query(`select worker_record_result($1, $2, 'signup.email', 'flaky')`, [mobRun, t1]);
assert.equal((await one(`select count(*)::int c from run_results where run_test_id = $1`, [t1])).c, 1, "один результат на выполнение сценария");
assert.equal((await one(`select status from run_results where run_test_id = $1`, [t1])).status, "flaky");

console.log("✓ run_results: запись воркером, перезапись попытки, storage_dump скрыт от authenticated");

// ------------------------------------------------------------------ fixture_template (миграция 005)
assert.ok((await one(`select count(*)::int c from information_schema.columns where table_name='runs' and column_name='fixture_template'`)).c === 1, "колонка runs.fixture_template есть");
// QA может задать шаблон при создании прогона
await db.exec(`set role authenticated`);
await as(viewer); // роль qa (повышен ранее)
const tplRun = (await one(
  `insert into runs (suite_id, stand_id, build_tag, created_by, trigger, status, fixture_template) values ($1, $2, 'tpl', $3, 'manual', 'queued', 'us-adult') returning id`,
  [suite, qa, viewer],
)).id;
await db.exec(`reset role`);
await as(null);
assert.equal((await one(`select fixture_template from runs where id = $1`, [tplRun])).fixture_template, "us-adult");
console.log("✓ fixture_template: колонка и вставка шаблона из формы запуска");

console.log("\nВсе проверки миграций прошли.");
