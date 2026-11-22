import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stand } from "@e2e/shared";
import { createCodeProvider, extractCode, HttpCodeProvider, type CodeProviderConfig, type FetchImpl } from "./codes.ts";

const stand = { slug: "qa", allowed_hosts: ["codes.qa.test"], test_flags: {} } as unknown as Stand;

/** Мини-ответ, совместимый с тем, что читает провайдер (status + text()). */
function resp(status: number, body: string) {
  return { status, async text() { return body; } } as unknown as Response;
}

interface Call { url: string; method?: string; headers?: Record<string, string>; body?: unknown }

/** Фейковый fetch по очереди ответов/ошибок; запоминает вызовы. */
function fakeFetch(steps: (Response | Error)[]): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function provider(config: Partial<CodeProviderConfig>, steps: (Response | Error)[], extra?: { secrets?: Record<string, string>; forbidden?: string[]; signal?: AbortSignal }) {
  const { fetchImpl, calls } = fakeFetch(steps);
  const p = new HttpCodeProvider({
    stand,
    config: { url: "https://codes.qa.test/", timeout_ms: 150, poll_interval_ms: 20, request_timeout_ms: 100, ...config },
    secrets: extra?.secrets ?? {},
    forbidden: extra?.forbidden ?? [],
    signal: extra?.signal ?? new AbortController().signal,
    fetchImpl,
  });
  return { p, calls };
}

test("extractCode: поле JSON по dot-пути и регэксп", () => {
  assert.equal(extractCode('{"data":{"code":"482913"}}', { data: { code: "482913" } }, { field: "data.code" }), "482913");
  assert.equal(extractCode("Ваш код: 123456 действует 5 минут", undefined, { regex: "\\b(\\d{4,8})\\b" }), "123456");
  // поле есть, но пустое → кода ещё нет
  assert.equal(extractCode('{"code":null}', { code: null }, { field: "code" }), null);
  // поле-строка + регэксп поверх него
  assert.equal(extractCode('{"msg":"code is 9087"}', { msg: "code is 9087" }, { field: "msg", regex: "(\\d{4})" }), "9087");
});

test("waitForCode: ждёт код, терпит 'ещё не готов', извлекает по полю", async () => {
  const { p, calls } = provider(
    { path: "/codes/{id}", extract: { field: "code" } },
    [resp(404, ""), resp(200, '{"code":null}'), resp(200, '{"code":"551234"}')],
  );
  const code = await p.waitForCode("user@mail.test");
  assert.equal(code, "551234");
  assert.ok(calls.length >= 3, "опрашивал до появления кода");
  assert.match(calls[0]!.url, /\/codes\/user%40mail\.test$/, "{id} подставлен и экранирован");
});

test("waitForCode: регэксп по текстовому телу", async () => {
  const { p } = provider({ extract: { regex: "code=(\\d{6})" } }, [resp(200, "status=pending"), resp(200, "code=778812")]);
  assert.equal(await p.waitForCode("req-1"), "778812");
});

test("waitForCode: таймаут при ответах без кода → kind timeout", async () => {
  const { p } = provider({ extract: { field: "code" } }, [resp(200, '{"code":null}')]);
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => {
    assert.equal(e.name, "TimeoutError", "классифицируется как timeout, не ретраится по умолчанию");
    assert.match(e.message, /не получен за 150 мс/);
    return true;
  });
});

test("waitForCode: источник недоступен (сеть падает) → InfraError", async () => {
  const { p } = provider({}, [new Error("ECONNREFUSED")]);
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => {
    assert.equal(e.name, "InfraError", "полная недоступность — инфраструктурная ошибка (ретраится)");
    return true;
  });
});

test("waitForCode: 401 от источника → InfraError немедленно", async () => {
  const { p, calls } = provider({}, [resp(401, "unauthorized")]);
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => e.name === "InfraError");
  assert.equal(calls.length, 1, "не продолжает опрос при ошибке авторизации");
});

test("waitForCode: URL вне allowlist стенда → GuardError", async () => {
  const { p } = provider({ url: "https://evil.example.com/" }, [resp(200, '{"code":"1"}')]);
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => {
    assert.equal(e.name, "GuardError");
    return true;
  });
});

test("waitForCode: запрещённый хост → GuardError даже внутри allowlist", async () => {
  const s = { slug: "qa", allowed_hosts: ["codes.qa.test"], test_flags: {} } as unknown as Stand;
  const { fetchImpl } = fakeFetch([resp(200, '{"code":"1"}')]);
  const p = new HttpCodeProvider({
    stand: s,
    config: { url: "https://codes.qa.test/", timeout_ms: 100, poll_interval_ms: 20 },
    secrets: {},
    forbidden: ["codes.qa.test"],
    signal: new AbortController().signal,
    fetchImpl,
  });
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => e.name === "GuardError");
});

test("waitForCode: отмена сигналом → CancelledError", async () => {
  const ac = new AbortController();
  ac.abort();
  const { p, calls } = provider({ extract: { field: "code" } }, [resp(200, '{"code":null}')], { signal: ac.signal });
  await assert.rejects(() => p.waitForCode("x"), (e: Error) => e.name === "CancelledError");
  assert.equal(calls.length, 0, "при уже отменённом сигнале запрос не уходит");
});

test("waitForCode: Bearer-токен из секрета, POST шлёт тело {id}", async () => {
  const { p, calls } = provider(
    { method: "POST", token_secret: "codes_token", extract: { field: "code" } },
    [resp(200, '{"code":"246802"}')],
    { secrets: { codes_token: "s3cr3t" } },
  );
  assert.equal(await p.waitForCode("abc"), "246802");
  assert.equal(calls[0]!.method, "POST");
  assert.equal((calls[0]!.headers as Record<string, string>).Authorization, "Bearer s3cr3t");
  assert.equal(calls[0]!.body, JSON.stringify({ id: "abc" }));
});

test("release: вызывает release_path методом DELETE с экранированным id", async () => {
  const { p, calls } = provider({ release_path: "/req/{id}" }, [resp(200, "")]);
  await p.release("ab/cd");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "DELETE");
  assert.match(calls[0]!.url, /\/req\/ab%2Fcd$/);
});

test("createCodeProvider: без конфига — заглушка с понятной ошибкой", async () => {
  const none = createCodeProvider({ stand, secrets: {}, forbidden: [], signal: new AbortController().signal });
  await assert.rejects(() => none.waitForCode("x"), /code_provider/);
  // с конфигом из test_flags — рабочий HTTP-провайдер
  const configured = { ...stand, test_flags: { code_provider: { url: "https://codes.qa.test/" } } } as unknown as Stand;
  const p = createCodeProvider({ stand: configured, secrets: {}, forbidden: [], signal: new AbortController().signal });
  assert.ok(p instanceof HttpCodeProvider);
});
