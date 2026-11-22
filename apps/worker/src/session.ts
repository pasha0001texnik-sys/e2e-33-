// Сессия одной попытки теста: браузерный контекст Playwright (web)
// или Appium-сессия на эмуляторе/устройстве (android, ios).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardError, traceHeaders, type BrowserProfile, type NetworkError, type Run, type RunTest, type Stand } from "@e2e/shared";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { remote } from "webdriverio";
import type { Config } from "./config.ts";
import type { RunLogger } from "./logger.ts";
import { installNetworkGuards, type GuardState } from "./preflight.ts";
import type { StandFlags } from "./scenarios/types.ts";

export interface CaptureResult {
  png?: Buffer;
  source?: { body: string; ext: string; contentType: string };
}

export interface TestSession {
  kind: "web" | "mobile";
  web?: { page: Page; context: BrowserContext };
  mobile?: { driver: WebdriverIO.Browser; platform: "android" | "ios" };
  /** Сетевые ошибки текущего шага (только web) */
  netErrors: NetworkError[];
  capture(): Promise<CaptureResult>;
  /** Бросает GuardError, если запрос ушёл за пределы allowlist */
  assertSafe(): void;
  /** Закрывает сессию; при keepTrace возвращает zip трейса Playwright */
  close(keepTrace: boolean): Promise<Buffer | null>;
  /** Дамп cookies/localStorage (web). null для мобильных и если захват выключен. */
  storageDump(): Promise<Record<string, unknown> | null>;
}

export async function openWebSession(o: {
  browser: Browser;
  stand: Stand;
  run: Run;
  test: RunTest;
  flags: StandFlags;
  cfg: Config;
  log: RunLogger;
  /** Браузерный профиль по локали шаблона прогона: locale, timezone, UA, viewport */
  profile?: BrowserProfile;
}): Promise<TestSession> {
  const { browser, stand, run, test, flags, cfg, log, profile } = o;
  const tlog = log.for(test.id);
  // Чистый контекст на каждую попытку: без кэша, cookies и storage
  const context = await browser.newContext({
    baseURL: stand.base_url,
    locale: profile?.locale ?? "ru-RU",
    timezoneId: profile?.timezone,
    userAgent: profile?.user_agent,
    viewport: profile?.viewport ?? { width: 1366, height: 900 },
    ignoreHTTPSErrors: flags.ignore_https_errors === true,
    serviceWorkers: "block", // иначе запросы SW обходят сетевой guard
  });
  const guard: GuardState = await installNetworkGuards(
    context,
    stand,
    (host) => tlog.warn(`Заблокирован запрос к хосту вне allowlist: ${host}`),
    { traceId: run.trace_id, headers: traceHeaders({ traceId: run.trace_id, runId: run.id, testId: test.id }) },
  );
  const tracing = cfg.TRACE_MODE !== "off";
  if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  const netErrors: NetworkError[] = [];
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "failed";
    if (failure.includes("ERR_BLOCKED_BY_CLIENT")) return;
    netErrors.push({ url: log.redact(req.url()).slice(0, 500), method: req.method(), failure });
  });
  page.on("response", (res) => {
    if (res.status() >= 500) netErrors.push({ url: log.redact(res.url()).slice(0, 500), method: res.request().method(), status: res.status() });
  });

  return {
    kind: "web",
    web: { page, context },
    netErrors,
    async capture() {
      const out: CaptureResult = {};
      try {
        out.png = await page.screenshot({ fullPage: true, mask: [page.locator('input[type="password"]')], timeout: 10000 });
      } catch {
        /* страница могла закрыться */
      }
      try {
        out.source = { body: log.redact(await page.content()), ext: "html", contentType: "text/html" };
      } catch {
        /* ignore */
      }
      return out;
    },
    assertSafe() {
      if (guard.violations.length) {
        throw new GuardError(`Запрос ушёл на хост вне allowlist: ${guard.violations[0]}. Тест остановлен.`);
      }
    },
    async storageDump() {
      try {
        return (await context.storageState()) as unknown as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async close(keepTrace) {
      let trace: Buffer | null = null;
      if (tracing) {
        if (keepTrace) {
          const dir = await mkdtemp(join(tmpdir(), "trace-"));
          const file = join(dir, "trace.zip");
          await context.tracing.stop({ path: file }).catch(() => {});
          trace = await readFile(file).catch(() => null);
          await rm(dir, { recursive: true, force: true });
        } else {
          await context.tracing.stop().catch(() => {});
        }
      }
      await context.close().catch(() => {});
      return trace;
    },
  };
}

/** Параметры подключения к Appium из appium_url стенда. */
export function appiumConnection(appiumUrl: string) {
  const u = new URL(appiumUrl);
  const protocol = u.protocol === "https:" ? "https" : "http";
  return {
    protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : protocol === "https" ? 443 : 4723,
    path: u.pathname && u.pathname !== "" ? u.pathname : "/",
  } as const;
}

/** W3C capabilities: значения по умолчанию для платформы + capabilities стенда. */
export function mobileCapabilities(stand: Pick<Stand, "platform" | "capabilities">): Record<string, unknown> {
  const ios = stand.platform === "ios";
  return {
    platformName: ios ? "iOS" : "Android",
    "appium:automationName": ios ? "XCUITest" : "UiAutomator2",
    "appium:newCommandTimeout": 300,
    // каждая попытка — с чистым состоянием приложения, если стенд не решил иначе
    "appium:noReset": false,
    "wdio:enforceWebDriverClassic": true,
    ...stand.capabilities,
  };
}

export async function openMobileSession(o: { stand: Stand; test: RunTest; log: RunLogger }): Promise<TestSession> {
  const { stand, test, log } = o;
  if (!stand.appium_url) throw new Error(`У мобильного стенда ${stand.slug} не задан appium_url`);
  const platform = stand.platform === "ios" ? "ios" : "android";
  log.for(test.id).info(`Appium-сессия ${platform} на ${new URL(stand.appium_url).host}`);
  const driver = await remote({
    ...appiumConnection(stand.appium_url),
    capabilities: mobileCapabilities(stand) as WebdriverIO.Capabilities,
    logLevel: "error",
    connectionRetryCount: 1,
    connectionRetryTimeout: 180_000,
    waitforTimeout: 15_000,
  });

  return {
    kind: "mobile",
    mobile: { driver, platform },
    netErrors: [],
    async capture() {
      const out: CaptureResult = {};
      try {
        out.png = Buffer.from(await driver.takeScreenshot(), "base64");
      } catch {
        /* сессия могла упасть */
      }
      try {
        out.source = { body: log.redact(await driver.getPageSource()), ext: "xml", contentType: "application/xml" };
      } catch {
        /* ignore */
      }
      return out;
    },
    assertSafe() {
      // трафик нативного приложения воркер не перехватывает: защиту дают сборка под тестовый
      // контур и маркер /health стенда, проверенный до старта
    },
    async storageDump() {
      return null;
    },
    async close() {
      await driver.deleteSession().catch(() => {});
      return null;
    },
  };
}
