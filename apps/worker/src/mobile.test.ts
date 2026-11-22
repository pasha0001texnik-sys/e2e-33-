// Мобильный путь без эмулятора: фейковый Appium (W3C WebDriver) с моделью экранов приложения
// + почтовый API на фейковом стенде. Через настоящий webdriverio гоняются мобильные сценарии.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Run, RunTest, Stand } from "@e2e/shared";
import { syntheticUser } from "@e2e/shared/node";
import type { FixtureService, UserFixture } from "./fixtures.ts";
import { Mailbox } from "./mail.ts";
import { getScenario } from "./scenarios/index.ts";
import type { MobileScenarioContext } from "./scenarios/types.ts";
import { appiumConnection, mobileCapabilities, openMobileSession } from "./session.ts";
import { RunLogger } from "./logger.ts";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface Mail {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
  Text: string;
  HTML: string;
}

const mails: Mail[] = [];
const accounts = new Map<string, { password: string; verified: boolean; code: string }>();
const unknown: string[] = [];
let lastCaps: Record<string, unknown> = {};

// ---------------------------------------------------------------- модель приложения
const SCREENS: Record<string, string[]> = {
  home: ["nav-signup", "nav-login"],
  signup: ["signup-email", "signup-password", "signup-first-name", "signup-submit"],
  signupDone: ["signup-done", "verify-code", "verify-submit"],
  verified: ["verify-done"],
  login: ["login-email", "login-password", "login-submit"],
  loginError: ["login-email", "login-password", "login-submit", "login-error"],
  app: ["user-menu"],
};

interface AppSession {
  screen: string;
  values: Record<string, string>;
}
const sessions = new Map<string, AppSession>();
let sessionSeq = 0;

function tap(s: AppSession, id: string) {
  if (id === "nav-signup") s.screen = "signup";
  else if (id === "nav-login") s.screen = "login";
  else if (id === "signup-submit") {
    const email = s.values["signup-email"]!;
    const code = String(100000 + accounts.size * 7919).slice(0, 6);
    accounts.set(email, { password: s.values["signup-password"]!, verified: false, code });
    mails.push({
      ID: String(mails.length + 1),
      To: [{ Address: email }],
      Subject: "Код подтверждения",
      Created: new Date().toISOString(),
      Text: `Ваш код: ${code}`,
      HTML: `<p>Ваш код: <b>${code}</b></p>`,
    });
    s.screen = "signupDone";
  } else if (id === "verify-submit") {
    const acc = [...accounts.values()].find((a) => a.code === s.values["verify-code"]);
    if (acc) {
      acc.verified = true;
      s.screen = "verified";
    }
  } else if (id === "login-submit") {
    const acc = accounts.get(s.values["login-email"]!);
    s.screen = acc?.verified && acc.password === s.values["login-password"] ? "app" : "loginError";
  }
}

// ---------------------------------------------------------------- фейковый Appium
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

let appium: Server;
let stand: Server;
let appiumUrl = "";
let standUrl = "";

before(async () => {
  appium = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ value }));
    };
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.replace(/^\/wd\/hub/, "").split("/").filter(Boolean);
    const b = req.method === "POST" ? await body(req) : {};

    if (parts[0] === "status") return send(200, { ready: true });
    if (parts[0] === "session" && parts.length === 1 && req.method === "POST") {
      lastCaps = ((b.capabilities as { alwaysMatch?: Record<string, unknown> })?.alwaysMatch ?? {}) as Record<string, unknown>;
      const id = `session-${++sessionSeq}`;
      sessions.set(id, { screen: "home", values: {} });
      return send(200, { sessionId: id, capabilities: { ...lastCaps, platformName: lastCaps.platformName ?? "Android" } });
    }
    const s = sessions.get(parts[1] ?? "");
    if (!s) return send(404, { error: "invalid session id", message: "no session" });
    const [, , cmd, elId, sub] = parts;

    if (parts.length === 2 && req.method === "DELETE") {
      sessions.delete(parts[1]!);
      return send(200, null);
    }
    if (cmd === "element" && !elId && req.method === "POST") {
      const id = String(b.value);
      if (b.using !== "accessibility id" || !SCREENS[s.screen]!.includes(id)) {
        return send(404, { error: "no such element", message: `${b.using}=${id} не найден на экране ${s.screen}` });
      }
      return send(200, { [ELEMENT_KEY]: id });
    }
    if (cmd === "elements" && req.method === "POST") {
      const id = String(b.value);
      return send(200, b.using === "accessibility id" && SCREENS[s.screen]!.includes(id) ? [{ [ELEMENT_KEY]: id }] : []);
    }
    if (cmd === "element" && elId) {
      const present = SCREENS[s.screen]!.includes(elId);
      if (!present) return send(404, { error: "stale element reference", message: `${elId} исчез` });
      if (sub === "displayed" || sub === "enabled") return send(200, true);
      if (sub === "clear") {
        s.values[elId] = "";
        return send(200, null);
      }
      if (sub === "value") {
        s.values[elId] = (s.values[elId] ?? "") + String(b.text ?? "");
        return send(200, null);
      }
      if (sub === "click") {
        tap(s, elId);
        return send(200, null);
      }
      if (sub === "text") return send(200, s.values[elId] ?? elId);
    }
    if (cmd === "screenshot") return send(200, PNG_1PX);
    if (cmd === "source") return send(200, `<hierarchy screen="${s.screen}"/>`);
    if (cmd === "context") return send(200, "NATIVE_APP");
    if (cmd === "contexts") return send(200, ["NATIVE_APP"]);
    if (cmd === "timeouts") return send(200, null);
    unknown.push(`${req.method} /${parts.slice(2).join("/")}`);
    return send(404, { error: "unknown command", message: `не реализовано: ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((r) => appium.listen(0, "127.0.0.1", r));
  appiumUrl = `http://127.0.0.1:${(appium.address() as { port: number }).port}/wd/hub`;

  // стенд: только Mailpit-совместимый API
  stand = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/api/v1/search") {
      const to = /to:"([^"]+)"/.exec(url.searchParams.get("query") ?? "")?.[1];
      return json({ messages: mails.filter((m) => m.To.some((t) => t.Address === to)) });
    }
    if (url.pathname.startsWith("/api/v1/message/")) return json(mails.find((m) => m.ID === url.pathname.split("/").pop()));
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => stand.listen(0, "127.0.0.1", r));
  standUrl = `http://127.0.0.1:${(stand.address() as { port: number }).port}`;
});

after(() => {
  appium.closeAllConnections();
  stand.closeAllConnections();
  appium.close();
  stand.close();
});

// ---------------------------------------------------------------- тесты
test("параметры Appium из appium_url и capabilities стенда", () => {
  assert.deepEqual(appiumConnection("http://appium:4723"), { protocol: "http", hostname: "appium", port: 4723, path: "/" });
  assert.deepEqual(appiumConnection("https://farm.example.test/wd/hub"), { protocol: "https", hostname: "farm.example.test", port: 443, path: "/wd/hub" });
  const caps = mobileCapabilities({ platform: "ios", capabilities: { "appium:deviceName": "iPhone 15", "appium:noReset": true } });
  assert.equal(caps.platformName, "iOS");
  assert.equal(caps["appium:automationName"], "XCUITest");
  assert.equal(caps["appium:noReset"], true, "capabilities стенда важнее значений по умолчанию");
});

test("мобильные сценарии через Appium: регистрация с кодом из письма, вход, неверный пароль", { timeout: 60000 }, async () => {
  const standRow = {
    id: "m-stand",
    slug: "android-qa",
    platform: "android",
    appium_url: appiumUrl,
    capabilities: { "appium:deviceName": "emulator-5554", "appium:appPackage": "test.app" },
    base_url: standUrl,
    allowed_hosts: ["127.0.0.1"],
    mailbox_api_url: standUrl,
    mail_domain: "mail.qa.example.test",
    test_flags: {},
  } as unknown as Stand;
  const run = { id: "8f14e45f-ceea-467a-9575-1b2b0c8f2a11", trace_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" } as Run;

  const created: UserFixture[] = [];
  const verified = new Set<string>();
  const fixtures = {
    async createUser() {
      const u = { id: `fx-${created.length + 1}`, ...syntheticUser({ runId: run.id, n: created.length + 1, mailDomain: "mail.qa.example.test" }) };
      created.push(u);
      return u;
    },
    async claimUser() {
      return created.find((c) => verified.has(c.id)) ?? null;
    },
    async markVerified(id: string) {
      verified.add(id);
    },
  } as unknown as FixtureService;

  const fakeDb = { from: () => ({ insert: async () => ({ error: null }) }) } as never;
  const log = new RunLogger(fakeDb, run.id, run.trace_id);
  const steps: string[] = [];
  const shared = new Map<string, Record<string, unknown>>();
  try {
    for (const key of ["signup.verify-email", "login.password", "login.wrong-password"]) {
      const session = await openMobileSession({ stand: standRow, test: { id: key } as RunTest, log });
      try {
        const ctx: MobileScenarioContext = {
          driver: session.mobile!.driver,
          platform: "android",
          ui: {
            fill: (el, t) => el.setValue(t),
            tap: (el) => el.click(),
          },
          stand: standRow,
          run,
          test: { id: key, scenario_key: key, depends_on: [] } as unknown as RunTest,
          attempt: 1,
          secrets: {},
          flags: {},
          fixtures,
          mail: new Mailbox(standRow),
          step: async (name, fn) => {
            steps.push(`${key}: ${name}`);
            return fn();
          },
          log: () => {},
          share: (k, v) => shared.set(key, { ...(shared.get(key) ?? {}), [k]: v }),
          fromDependency: () => undefined,
        };
        await getScenario(key)!.runMobile!(ctx);
        const shot = await session.capture();
        assert.ok(shot.png && shot.png.length > 0, "скриншот с устройства");
        assert.match(shot.source?.body ?? "", /<hierarchy/, "дерево экрана");
      } finally {
        await session.close(false);
      }
    }
  } finally {
    await log.close();
  }

  assert.equal(created.length, 1, "вход переиспользует подтверждённого пользователя");
  assert.ok(verified.has("fx-1"));
  assert.ok(accounts.get(created[0]!.email)?.verified, "почта подтверждена кодом из письма");
  assert.equal(shared.get("signup.verify-email")?.user, "fx-1");
  assert.ok(steps.includes("login.password: Проверить, что пользователь вошёл"));
  assert.ok(steps.includes("login.wrong-password: Проверить сообщение об ошибке"));
  assert.equal(lastCaps.platformName, "Android");
  assert.equal(lastCaps["appium:automationName"], "UiAutomator2");
  assert.equal(sessions.size, 0, "все Appium-сессии закрыты");
  assert.deepEqual(unknown, [], "webdriverio не вызывал неожиданных команд");
});
