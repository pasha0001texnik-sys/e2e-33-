// Интеграционные тесты воркера без Supabase: фейковый стенд на 127.0.0.1
// (страницы регистрации/входа, /health, Mailpit-совместимый API) + настоящий Chrome.
// Браузер: CHROME_PATH или /usr/bin/google-chrome; без него браузерные тесты пропускаются.

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Run, RunTest, Stand } from "@e2e/shared";
import { syntheticUser } from "@e2e/shared/node";
import { chromium, type Browser } from "@playwright/test";
import type { FixtureService, UserFixture } from "./fixtures.ts";
import { Mailbox } from "./mail.ts";
import { installNetworkGuards, preflight } from "./preflight.ts";
import { nextFire } from "./scheduler.ts";
import { getScenario } from "./scenarios/index.ts";
import type { ScenarioContext } from "./scenarios/types.ts";

// ---------------------------------------------------------------- фейковый стенд
interface Mail {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
  Text: string;
  HTML: string;
}
const users = new Map<string, { password: string; verified: boolean }>();
const mails: Mail[] = [];
let health = { env: "qa", build_tag: "b42" };
let server: Server;
let base = "";

const page = (body: string) =>
  `<!doctype html><html><head><script src="https://www.google-analytics.com/analytics.js"></script></head><body>${body}</body></html>`;

async function readBody(req: IncomingMessage) {
  let s = "";
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", base);
  const send = (code: number, html: string, type = "text/html") => {
    res.writeHead(code, { "content-type": type });
    res.end(html);
  };
  const json = (o: unknown) => send(200, JSON.stringify(o), "application/json");

  if (url.pathname === "/health") return json(health);
  if (url.pathname === "/signup" && req.method === "GET") {
    return send(
      200,
      page(`<form method="post" action="/signup">
        <input data-testid="signup-email" name="email"><input data-testid="signup-password" name="password" type="password">
        <input data-testid="signup-first-name" name="first"><button data-testid="signup-submit">Создать</button></form>`),
    );
  }
  if (url.pathname === "/signup" && req.method === "POST") {
    return void readBody(req).then((f) => {
      const email = f.get("email")!;
      users.set(email, { password: f.get("password")!, verified: false });
      const token = Buffer.from(email).toString("base64url");
      const link = `${base}/verify?token=${token}`;
      mails.push({
        ID: String(mails.length + 1),
        To: [{ Address: email }],
        Subject: "Подтвердите почту",
        Created: new Date().toISOString(),
        Text: `Перейдите: ${link}`,
        HTML: `<a href="https://tracker.evil.test/x">x</a> <a href="${link}">Подтвердить</a>`,
      });
      send(200, page(`<p data-testid="signup-done">Проверьте почту</p>`));
    });
  }
  if (url.pathname === "/verify") {
    const email = Buffer.from(url.searchParams.get("token") ?? "", "base64url").toString();
    const u = users.get(email);
    if (u) u.verified = true;
    return send(200, page(u ? `<p data-testid="verify-done">Почта подтверждена</p>` : `<p>bad token</p>`));
  }
  if (url.pathname === "/login" && req.method === "GET") {
    return send(
      200,
      page(`<form method="post" action="/login"><input data-testid="login-email" name="email">
        <input data-testid="login-password" name="password" type="password"><button data-testid="login-submit">Войти</button></form>`),
    );
  }
  if (url.pathname === "/login" && req.method === "POST") {
    return void readBody(req).then((f) => {
      const u = users.get(f.get("email")!);
      if (u?.verified && u.password === f.get("password")) return send(200, page(`<div data-testid="user-menu">Профиль</div>`));
      send(401, page(`<p data-testid="login-error">Неверный email или пароль</p>`));
    });
  }
  if (url.pathname === "/api/v1/search") {
    const to = /to:"([^"]+)"/.exec(url.searchParams.get("query") ?? "")?.[1];
    return json({ messages: mails.filter((m) => m.To.some((t) => t.Address === to)) });
  }
  if (url.pathname.startsWith("/api/v1/message/")) {
    return json(mails.find((m) => m.ID === url.pathname.split("/").pop()));
  }
  send(404, "not found");
}

let stand: Stand;
const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const hasChrome = existsSync(chromePath);
let browser: Browser | undefined;

before(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  stand = {
    id: "stand-1",
    slug: "fake-qa",
    name: "Fake QA",
    env: "qa",
    base_url: base,
    allowed_hosts: ["127.0.0.1"],
    health_url: `${base}/health`,
    expected_env_marker: "qa",
    mail_domain: "mail.qa.example.test",
    mailbox_api_url: base,
    cleanup_api_url: null,
    max_concurrency: 2,
    max_holds: 1,
    rps_limit: null,
    quiet_hours: null,
    fixture_ttl_minutes: 60,
    mocks: { routes: [{ url: "**/api/sms/send", json: { ok: true, mocked: true } }] },
    test_flags: {},
    is_active: true,
    created_at: "",
    updated_at: "",
  };
  if (hasChrome) browser = await chromium.launch({ executablePath: chromePath, headless: true });
});

after(async () => {
  await browser?.close();
  server.close();
});

const run = { id: "8f14e45f-ceea-467a-9575-1b2b0c8f2a11", build_tag: "b42" } as Run;

// ---------------------------------------------------------------- тесты
test("планировщик: следующий запуск по cron в часовом поясе", () => {
  const n = nextFire("0 9 * * 1-5", "Europe/Moscow", new Date("2026-11-21T12:00:00Z")); // суббота
  assert.equal(n.toISOString(), "2026-11-23T06:00:00.000Z"); // пн 09:00 МСК
});

test("preflight: маркер окружения и версия сборки", async () => {
  health = { env: "qa", build_tag: "b42" };
  const ok = await preflight(stand, run, [], 3000);
  assert.equal(ok.deployedBuild, "b42");

  await assert.rejects(preflight(stand, { ...run, build_tag: "b41" }, [], 3000), /развернул сборку b42/);
  health = { env: "production", build_tag: "b42" };
  await assert.rejects(preflight(stand, run, [], 3000), /production/);
  health = { env: "qa", build_tag: "b42" };
  await assert.rejects(preflight({ ...stand, allowed_hosts: ["qa.example.test"] }, run, [], 3000), /allowed_hosts/);
});

test("сетевой guard: чужие хосты блокируются, моки отвечают", { skip: !hasChrome && "нет Chrome" }, async () => {
  const context = await browser!.newContext({ baseURL: base, serviceWorkers: "block" });
  const blocked: string[] = [];
  await installNetworkGuards(context, stand, (h) => blocked.push(h));
  const p = await context.newPage();
  await p.goto("/login");
  const mocked = await p.evaluate(() => fetch("/api/sms/send", { method: "POST" }).then((r) => r.json()));
  assert.deepEqual(mocked, { ok: true, mocked: true });
  const outside = await p.evaluate(() =>
    fetch("https://example.org/").then(
      () => "loaded",
      () => "blocked",
    ),
  );
  assert.equal(outside, "blocked");
  assert.ok(blocked.includes("www.google-analytics.com"), `заблокированы: ${blocked.join(", ")}`);
  await context.close();
});

test("ссылки из письма: только на хосты стенда", () => {
  const mb = new Mailbox(stand);
  const msg = { id: "1", subject: "", to: [], text: "", receivedAt: "", html: `<a href="https://tracker.evil.test/verify">x</a> <a href="${base}/verify?token=a&amp;b=1">ok</a>` };
  assert.equal(mb.extractLink(msg, "verify"), `${base}/verify?token=a&b=1`);
  assert.equal(Mailbox.extractCode({ ...msg, text: "Ваш код: 482910" }), "482910");
});

test("сценарии регистрации, подтверждения почты и входа на фейковом стенде", { skip: !hasChrome && "нет Chrome" }, async () => {
  const created: UserFixture[] = [];
  const verified = new Set<string>();
  const fixtures = {
    async createUser() {
      const u = { id: `fx-${created.length + 1}`, ...syntheticUser({ runId: run.id, n: created.length + 1, mailDomain: stand.mail_domain! }) };
      created.push(u);
      return u;
    },
    async claimUser() {
      const u = created.find((c) => verified.has(c.id));
      return u ?? null;
    },
    async markVerified(id: string) {
      verified.add(id);
    },
    async markFailed() {},
  } as unknown as FixtureService;

  const steps: string[] = [];
  const makeCtx = async (key: string) => {
    const context = await browser!.newContext({ baseURL: base, serviceWorkers: "block" });
    await installNetworkGuards(context, stand, () => {});
    const ctx: ScenarioContext = {
      page: await context.newPage(),
      context,
      stand,
      run,
      test: { id: key, scenario_key: key } as RunTest,
      attempt: 1,
      secrets: {},
      flags: {},
      fixtures,
      mail: new Mailbox(stand),
      step: async (name, fn) => {
        steps.push(`${key}: ${name}`);
        return fn();
      },
      log: () => {},
    };
    return ctx;
  };

  for (const key of ["signup.verify-email", "login.password", "login.wrong-password"]) {
    const ctx = await makeCtx(key);
    await getScenario(key)!.run(ctx);
    await ctx.context.close();
  }
  assert.equal(created.length, 1, "вход переиспользует подтверждённого пользователя из реестра");
  assert.ok(verified.has("fx-1"));
  assert.ok(steps.includes("login.password: Проверить, что пользователь вошёл"));
  assert.ok(steps.includes("login.wrong-password: Проверить сообщение об ошибке"));
});

test("каталог сценариев в shared совпадает с реестром воркера", async () => {
  const { SCENARIO_CATALOG } = await import("@e2e/shared");
  const { listScenarios } = await import("./scenarios/index.ts");
  assert.deepEqual(
    SCENARIO_CATALOG.map((s) => s.key).sort(),
    listScenarios().map((s) => s.key).sort(),
  );
});

test("сетевой guard: редирект со стенда на чужой хост не проходит", { skip: !hasChrome && "нет Chrome", timeout: 30000 }, async () => {
  let outsideHits = 0;
  const outside = createServer((_q, r) => {
    outsideHits++;
    r.end("PROD");
  });
  await new Promise<void>((r) => outside.listen(0, "127.0.0.2", r));
  const target = `http://127.0.0.2:${(outside.address() as { port: number }).port}`;
  const redirector = createServer((q, r) => {
    if (q.url === "/inner") {
      r.writeHead(302, { location: "/ok", "set-cookie": "sid=1; Path=/" });
      return r.end();
    }
    if (q.url === "/ok") {
      r.writeHead(200, { "content-type": "text/html" });
      return r.end(`<p id="c">${q.headers.cookie ?? ""}</p>`);
    }
    r.writeHead(302, { location: `${target}/steal` });
    r.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  const rbase = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;

  const context = await browser!.newContext({ baseURL: rbase, serviceWorkers: "block" });
  try {
    const blocked: string[] = [];
    const guard = await installNetworkGuards(context, stand, (h) => blocked.push(h));
    const p = await context.newPage();
    await assert.rejects(p.goto("/go"), /ERR_BLOCKED_BY_CLIENT/);
    const p2 = await context.newPage();
    await p2.goto("/inner");
    assert.equal(await p2.locator("#c").textContent(), "sid=1", "внутренние редиректы и cookies работают");
    await p2.evaluate(() => fetch("/api").catch(() => null));
    await p2.evaluate(() => new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = "/img"; }));
    assert.equal(outsideHits, 0);
    assert.deepEqual(guard.violations, []);
    assert.ok(blocked.some((h) => h.startsWith("127.0.0.2")));
  } finally {
    await context.close();
    redirector.closeAllConnections();
    outside.closeAllConnections();
    redirector.close();
    outside.close();
  }
});
