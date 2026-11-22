import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertEnvMarker,
  assertStandSafe,
  GuardError,
  hostMatches,
  isRequestAllowed,
  patternsOverlap,
} from "./guard.ts";
import { classifyError, InfraError } from "./errors.ts";
import { emailAlias, generatePassword, syntheticUser } from "./fixtures.ts";
import { maskSecrets, redactText } from "./mask.ts";
import { finalRunStatus, summarize } from "./summary.ts";
import { signWebhook, verifyWebhook } from "./webhook.ts";

const stand = {
  slug: "qa",
  env: "qa",
  base_url: "https://qa.example.test",
  allowed_hosts: ["qa.example.test", "*.qa.example.test"],
  health_url: "https://qa.example.test/health",
};

test("allowlist хостов", () => {
  assert.ok(hostMatches("a.qa.example.test", "*.qa.example.test"));
  assert.ok(!hostMatches("qa.example.test", "*.qa.example.test"), "wildcard не покрывает апекс");
  assert.ok(!hostMatches("evilqa.example.test", "*.qa.example.test"));
  assert.ok(isRequestAllowed("https://cdn.qa.example.test/x.js", stand.allowed_hosts));
  assert.ok(!isRequestAllowed("https://www.google-analytics.com/c", stand.allowed_hosts));
  assert.ok(isRequestAllowed("data:image/png;base64,AA", stand.allowed_hosts));
});

test("стенд не может указывать на production", () => {
  assertStandSafe(stand, ["example.com"]);
  assert.throws(() => assertStandSafe({ ...stand, env: "production" }), GuardError);
  assert.throws(() => assertStandSafe({ ...stand, base_url: "https://example.com" }), /allowed_hosts/);
  assert.throws(
    () => assertStandSafe({ ...stand, base_url: "https://x.example.com", health_url: null, allowed_hosts: ["*.example.com"] }, ["api.example.com"]),
    /production/,
  );
  assert.ok(patternsOverlap("*.example.com", "*.api.example.com"));
  assert.ok(!patternsOverlap("*.example.test", "example.com"));
});

test("маркер окружения", () => {
  assertEnvMarker('{"env":"qa"}', "qa", "qa");
  assertEnvMarker("QA\n", "qa", "qa");
  assert.throws(() => assertEnvMarker('{"environment":"production"}', "qa", "qa"), /production/);
  assert.throws(() => assertEnvMarker('{"env":"staging"}', "qa", "qa"), /Ожидался/);
});

test("классификация ошибок", () => {
  assert.equal(classifyError(new Error("page.goto: net::ERR_CONNECTION_RESET at https://qa")), "infra");
  assert.equal(classifyError(new InfraError("x")), "infra");
  assert.equal(classifyError(new Error("expect(locator).toBeVisible() failed")), "assertion");
  assert.equal(classifyError(new GuardError("x")), "guard");
  const t = new Error("locator.click: Timeout 5000ms exceeded.");
  t.name = "TimeoutError";
  assert.equal(classifyError(t), "timeout");
});

test("синтетические данные", () => {
  const p = generatePassword({ minLength: 16 });
  assert.equal(p.length, 16);
  assert.match(p, /[A-Z]/);
  assert.match(p, /[a-z]/);
  assert.match(p, /[0-9]/);
  assert.match(p, /[^A-Za-z0-9]/);
  const e = emailAlias("8f14e45f-ceea-467a-9575-1b2b0c8f2a11", 3, "mail.qa.example.test");
  assert.match(e, /^e2e\+8f14e45f-3-[0-9a-f]{4}@mail\.qa\.example\.test$/);
  assert.throws(() => emailAlias("x", 1, "not a domain"));
  const u = syntheticUser({ runId: "abc", n: 1, mailDomain: "m.test", locale: "en" });
  assert.equal(u.locale, "en");
});

test("маскирование", () => {
  const m = maskSecrets({ email: "a@b.test", password: "SuperSecret1!", nested: { api_key: "abcdefgh" } });
  assert.equal(m.email, "a@b.test");
  assert.equal(m.password, "Su****");
  assert.equal(m.nested.api_key, "ab****");
  assert.equal(redactText("login with SuperSecret1! ok", ["SuperSecret1!"]), "login with **** ok");
  assert.equal(redactText("Authorization: Bearer abcdefghijk", []), "Authorization: Bearer ****");
});

test("итог прогона: flaky не роняет, failed роняет", () => {
  const s = summarize([{ status: "passed" }, { status: "flaky" }]);
  assert.equal(finalRunStatus(s, false), "passed");
  assert.equal(s.flaky, 1);
  assert.equal(finalRunStatus(summarize([{ status: "failed" }]), false), "failed");
  assert.equal(finalRunStatus(s, true), "cancelled");
});

test("подпись вебхука", () => {
  const ts = 1_800_000_000;
  const sig = signWebhook("k", ts, '{"a":1}');
  assert.deepEqual(verifyWebhook({ secret: "k", timestamp: String(ts), signature: sig, body: '{"a":1}', now: ts }), { ok: true });
  assert.equal(verifyWebhook({ secret: "k", timestamp: String(ts), signature: sig, body: '{"a":2}', now: ts }).ok, false);
  assert.equal(verifyWebhook({ secret: "k", timestamp: String(ts), signature: sig, body: '{"a":1}', now: ts + 1000 }).ok, false);
});

test("traceparent из trace_id", async () => {
  const { traceparent, traceHeaders } = await import("./trace.ts");
  const tp = traceparent("9F2C1A7E-0d3b-4a51-9c11-3f7e2b8a6d01");
  assert.match(tp, /^00-9f2c1a7e0d3b4a519c113f7e2b8a6d01-[0-9a-f]{16}-01$/);
  assert.notEqual(tp, traceparent("9f2c1a7e-0d3b-4a51-9c11-3f7e2b8a6d01"), "новый span на каждый вызов");
  assert.throws(() => traceparent("bad"));
  assert.deepEqual(Object.keys(traceHeaders({ traceId: "t", runId: "r" })), ["x-e2e-trace-id", "x-e2e-run-id"]);
});

test("зависимости сценариев раскрываются транзитивно и без циклов", async () => {
  const { withDependencies, SCENARIO_CATALOG } = await import("./scenarios.ts");
  assert.deepEqual(withDependencies(["login.after-onboarding"]), ["signup.verify-email", "onboarding.profile", "login.after-onboarding"]);
  assert.deepEqual(withDependencies(["signup.email", "onboarding.profile"]), ["signup.email", "signup.verify-email", "onboarding.profile"]);
  const all = withDependencies(SCENARIO_CATALOG.map((s) => s.key));
  assert.equal(all.length, SCENARIO_CATALOG.length);
  const cyc = new Map([["a", { dependsOn: ["b"] }], ["b", { dependsOn: ["a"] }]]);
  assert.throws(() => withDependencies(["a"], (k) => cyc.get(k)), /Циклическая/);
});

test("generatePerson: локали, пол, возраст, логин, пароль по политике", async () => {
  const { generatePerson, birthDateForAge } = await import("./fixtures.ts");
  const { getTemplate } = await import("./templates.ts");
  for (const key of ["default", "us-adult", "de-adult"]) {
    const t = getTemplate(key);
    const p = generatePerson({ runId: "8f14e45f-ceea-467a-9575-1b2b0c8f2a11", n: 1, mailDomain: "mail.qa.example.test", template: key });
    assert.equal(p.locale, t.locale);
    assert.ok(["male", "female"].includes(p.gender));
    assert.match(p.birth_date, /^\d{4}-\d{2}-\d{2}$/);
    const age = (Date.now() - new Date(p.birth_date).getTime()) / (365.25 * 864e5);
    assert.ok(age >= t.min_age - 1 && age <= t.max_age + 1, `возраст ${age} вне диапазона ${t.min_age}..${t.max_age}`);
    assert.match(p.login, /^[a-z]+\.[a-z]+\d{3}$/, `логин ASCII: ${p.login}`);
    assert.match(p.email, /^e2e\+/);
    assert.ok(p.password.length >= (t.password_policy.minLength ?? 14));
    if (t.password_policy.symbols === false) assert.doesNotMatch(p.password, /[!@#$%^&*\-_=+]/);
  }
  assert.throws(() => birthDateForAge(40, 20));
});

test("ru-RU: фамилия согласована с полом; транслитерация кириллицы в логин", async () => {
  const { generatePerson } = await import("./fixtures.ts");
  let sawFemale = false;
  for (let i = 0; i < 40; i++) {
    const p = generatePerson({ runId: "r", n: i, mailDomain: "m.test", locale: "ru-RU", template: "default" });
    assert.match(p.login, /^[a-z.]+\d{3}$/, `логин без кириллицы: ${p.login}`);
    if (p.gender === "female") {
      sawFemale = true;
      assert.match(p.last_name, /а$/, `женская фамилия: ${p.last_name}`);
    }
  }
  assert.ok(sawFemale);
});

test("browserProfile: часовой пояс и локаль согласованы", async () => {
  const { browserProfile } = await import("./fixtures.ts");
  assert.equal(browserProfile("ru-RU").timezone, "Europe/Moscow");
  assert.equal(browserProfile("en-US").timezone, "America/New_York");
  assert.equal(browserProfile("de-DE").timezone, "Europe/Berlin");
  const bp = browserProfile("en-US");
  assert.equal(bp.locale, "en-US");
  assert.match(bp.user_agent, /Chrome/);
  assert.ok(bp.viewport.width >= 1366);
});

test("exec-профили: дефолт instant тождественен текущему поведению", async () => {
  const { getExecProfile, EXEC_PROFILES, pickKeystrokeDelay } = await import("./timings.ts");
  const d = getExecProfile(null);
  assert.equal(d.key, "instant");
  assert.equal(pickKeystrokeDelay(d.timings), 0, "мгновенный ввод");
  assert.deepEqual(d.retry.retry_on, ["infra"], "по умолчанию повтор только infra");
  assert.equal(d.retry.base_delay_ms, 2000);
  const human = getExecProfile("human");
  const delay = pickKeystrokeDelay(human.timings);
  assert.ok(delay >= human.timings.keystroke_min_ms && delay <= human.timings.keystroke_max_ms);
  assert.equal(getExecProfile("stable").retry.retry_on.includes("timeout"), true);
  assert.equal(EXEC_PROFILES[0]!.key, "instant", "instant — первый (дефолт формы)");
});

test("net-профили: дефолт none без эмуляции, резолв прогон>стенд, каталог валиден", async () => {
  const { NET_PROFILES, getNetProfile, resolveNetProfile, hasEmulation, DEFAULT_NET_PROFILE } = await import("./netprofile.ts");

  // Дефолт — без эмуляции, тождественен прежнему поведению контекста
  const none = getNetProfile(null);
  assert.equal(none.key, "none");
  assert.equal(hasEmulation(none), false, "none ничего не эмулирует");
  assert.equal(NET_PROFILES[0]!.key, "none", "none — первый (дефолт формы)");
  assert.equal(DEFAULT_NET_PROFILE, "none");

  // Неизвестный ключ падает в дефолт, а не бросает
  assert.equal(getNetProfile("нет-такого").key, "none");

  // Резолв: выбор прогона переопределяет дефолт стенда; иначе — стенд; иначе — none
  assert.equal(resolveNetProfile("fast-3g", "slow-3g").key, "fast-3g", "прогон важнее стенда");
  assert.equal(resolveNetProfile(null, "slow-3g").key, "slow-3g", "дефолт стенда при пустом прогоне");
  assert.equal(resolveNetProfile(null, null).key, "none");

  // Сетевой профиль: условия заданы и считаются эмуляцией
  const slow = getNetProfile("slow-3g");
  assert.ok(hasEmulation(slow));
  assert.equal(slow.geo, null);
  assert.ok((slow.network?.download ?? 0) > 0 && (slow.network?.latency ?? 0) > 0);

  // offline — тоже эмуляция
  assert.equal(hasEmulation(getNetProfile("offline")), true);
  assert.equal(getNetProfile("offline").network?.offline, true);

  // Гео-профиль: координаты в диапазоне, есть подпись региона, сети нет
  for (const key of ["geo-moscow", "geo-berlin", "geo-newyork"]) {
    const g = getNetProfile(key);
    assert.ok(g.geo, `${key}: есть гео`);
    assert.ok(Math.abs(g.geo!.latitude) <= 90 && Math.abs(g.geo!.longitude) <= 180, `${key}: валидные координаты`);
    assert.ok(g.geo!.region && g.geo!.region.length > 0, `${key}: есть подпись региона`);
    assert.equal(hasEmulation(g), true);
  }

  // Все ключи уникальны
  const keys = NET_PROFILES.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, "ключи профилей уникальны");
});
