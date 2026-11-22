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
