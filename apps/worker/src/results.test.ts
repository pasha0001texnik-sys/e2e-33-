import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run, RunTest, Stand } from "@e2e/shared";
import { getNetProfile } from "@e2e/shared";
import { recordResult } from "./results.ts";

test("recordResult: собирает поля формы из фикстур, маскирует секреты, не шлёт пароль в form_fields", async () => {
  let rpcArgs: Record<string, unknown> | null = null;
  const db = {
    from: (t: string) => ({
      select: () => ({
        eq: async () => {
          assert.equal(t, "fixtures");
          return { data: [{ payload: { email: "e2e@mail.test", first_name: "Анна", last_name: "Тестова", gender: "female", birth_date: "1990-05-01", login: "anna.testova123" }, secret_payload: { password: "SuperSecret1!", token: "abcdef" } }] };
        },
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "worker_record_result");
      rpcArgs = args;
      return { data: null, error: null };
    },
  } as never;

  const run = { id: "r1" } as Run;
  const test_ = { id: "t1", scenario_key: "signup.email" } as RunTest;
  const stand = { env: "staging", test_flags: { region: "eu-central", network_profile: { latency: 40 } } } as unknown as Stand;

  await recordResult(db, { run, stand, test: test_, status: "passed", error: null, storageDump: { cookies: [{ name: "sid", value: "zzz" }] } });

  const a = rpcArgs as unknown as Record<string, Record<string, unknown>>;
  assert.equal(a.p_region, "eu-central");
  assert.equal((a.p_network_profile as { latency: number }).latency, 40);
  const ff = a.p_form_fields as Record<string, string>;
  assert.equal(ff.email, "e2e@mail.test", "email читается открыто");
  assert.equal(ff.first_name, "Анна", "имя открыто");
  assert.equal(ff.last_name, "Тестова", "фамилия открыто");
  assert.equal(ff.gender, "female", "пол открыто");
  assert.equal(ff.birth_date, "1990-05-01", "дата рождения открыто");
  assert.equal(ff.login, "anna.testova123", "логин открыто");
  assert.notEqual(ff.password, "SuperSecret1!", "пароль замаскирован");
  assert.match(String(ff.password), /\*\*\*\*/);
  assert.match(String(ff.token), /\*\*\*\*/);
  assert.ok((a.p_storage_dump as { cookies: unknown[] }).cookies, "дамп передаётся в защищённую колонку");
});

test("recordResult: region по умолчанию — окружение стенда", async () => {
  let region: unknown;
  const db = {
    from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      region = args.p_region;
      return { data: null, error: null };
    },
  } as never;
  await recordResult(db, {
    run: { id: "r" } as Run,
    stand: { env: "qa", test_flags: {} } as unknown as Stand,
    test: { id: "t", scenario_key: "x" } as RunTest,
    status: "failed",
    error: "boom",
    storageDump: null,
  });
  assert.equal(region, "qa");
});

test("recordResult: гео-профиль пишет координаты и переопределяет регион, сетевой — условия", async () => {
  let args: Record<string, unknown> = {};
  const db = {
    from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
    rpc: async (_fn: string, a: Record<string, unknown>) => {
      args = a;
      return { data: null, error: null };
    },
  } as never;

  // Гео-профиль: регион берётся из подписи, координаты попадают в network_profile.geo
  await recordResult(db, {
    run: { id: "r" } as Run,
    stand: { env: "qa", test_flags: { region: "eu-central" } } as unknown as Stand,
    test: { id: "t", scenario_key: "x" } as RunTest,
    status: "passed",
    error: null,
    storageDump: null,
    netProfile: getNetProfile("geo-berlin"),
  });
  const np = args.p_network_profile as { net_profile?: string; geo?: { latitude: number; region?: string } };
  assert.equal(np.net_profile, "geo-berlin");
  assert.equal(np.geo?.latitude, 52.52);
  assert.equal(args.p_region, "DE / Берлин", "регион берётся из гео-профиля, а не из флагов");

  // Сетевой профиль: условия троттлинга записаны, региона у профиля нет — остаётся флаг стенда
  await recordResult(db, {
    run: { id: "r" } as Run,
    stand: { env: "qa", test_flags: { region: "eu-central" } } as unknown as Stand,
    test: { id: "t", scenario_key: "x" } as RunTest,
    status: "passed",
    error: null,
    storageDump: null,
    netProfile: getNetProfile("slow-3g"),
  });
  const np2 = args.p_network_profile as { net_profile?: string; latency?: number; download?: number };
  assert.equal(np2.net_profile, "slow-3g");
  assert.equal(np2.latency, 400);
  assert.equal(np2.download, 50_000);
  assert.equal(args.p_region, "eu-central", "у сетевого профиля нет гео — регион из флагов стенда");
});
