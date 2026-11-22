import type { Platform, Run, RunTest, Stand } from "@e2e/shared";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { CodeProvider, CodeProviderConfig } from "../codes.ts";
import type { FixtureService } from "../fixtures.ts";
import type { Mailbox } from "../mail.ts";

export interface StepOptions {
  /** Таймаут шага в мс (по умолчанию — общий таймаут теста). */
  timeoutMs?: number;
}

export interface StandFlags {
  paths?: Partial<Record<"signup" | "login" | "onboarding" | "home" | "logout", string>>;
  /** Переопределение селекторов сценариев, ключ → CSS/testid-селектор (для мобильных — "~accessibility-id"). */
  selectors?: Record<string, string>;
  mail_provider?: "mailpit" | "mailhog";
  /** Источник проверочных кодов (HTTP) в пределах allowlist стенда; см. codes.ts */
  code_provider?: CodeProviderConfig;
  password_policy?: { minLength?: number; upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean };
  ignore_https_errors?: boolean;
  keep_fixtures?: boolean;
  [key: string]: unknown;
}

/** Общее для web- и мобильных сценариев. */
export interface BaseContext {
  stand: Stand;
  run: Run;
  test: RunTest;
  attempt: number;
  /** Секреты стенда из Vault (служебные токены). Никогда не логируйте их. */
  secrets: Record<string, string>;
  /** Флаги стенда: пути страниц, селекторы, политика паролей и т.п. */
  flags: StandFlags;
  fixtures: FixtureService;
  mail: Mailbox;
  /** Адаптер получения проверочного кода из HTTP-источника тестового контура */
  codes: CodeProvider;
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
  log(message: string, data?: Record<string, unknown>): void;
  /**
   * Передать значение зависимым тестам (id фикстуры, номер заказа и т.п.).
   * Не передавайте секреты: значения видны в панели.
   */
  share(key: string, value: string | number | boolean | null): void;
  /** Значение, которое передал тест-зависимость (только из объявленных в dependsOn). */
  fromDependency<T extends string | number | boolean | null = string>(scenarioKey: string, key: string): T | undefined;
}

export interface WebUi {
  /** Ввод текста с таймингами профиля (задержка между клавишами, паузы, скролл) */
  fill(locator: Locator, text: string): Promise<void>;
  click(locator: Locator): Promise<void>;
  check(locator: Locator): Promise<void>;
}

export interface ScenarioContext extends BaseContext {
  page: Page;
  context: BrowserContext;
  ui: WebUi;
}

export interface MobileUi {
  fill(element: WebdriverIO.Element, text: string): Promise<void>;
  tap(element: WebdriverIO.Element): Promise<void>;
}

export interface MobileScenarioContext extends BaseContext {
  driver: WebdriverIO.Browser;
  platform: Exclude<Platform, "web">;
  ui: MobileUi;
}

export interface Scenario {
  key: string;
  name: string;
  tags?: string[];
  /** Сценарии, которые должны пройти раньше этого (в том же прогоне, на том же стенде) */
  dependsOn?: string[];
  /** Реализация для web-стендов (Playwright) */
  run?(ctx: ScenarioContext): Promise<void>;
  /** Реализация для мобильных стендов (Appium) */
  runMobile?(ctx: MobileScenarioContext): Promise<void>;
}

export function supportsPlatform(s: Scenario, platform: Platform): boolean {
  return platform === "web" ? !!s.run : !!s.runMobile;
}
