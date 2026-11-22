import type { Run, RunTest, Stand } from "@e2e/shared";
import type { BrowserContext, Page } from "@playwright/test";
import type { FixtureService } from "../fixtures.ts";
import type { Mailbox } from "../mail.ts";

export interface StepOptions {
  /** Таймаут шага в мс (по умолчанию — общий таймаут теста). */
  timeoutMs?: number;
}

export interface ScenarioContext {
  page: Page;
  context: BrowserContext;
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
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface StandFlags {
  paths?: Partial<Record<"signup" | "login" | "onboarding" | "home" | "logout", string>>;
  /** Переопределение селекторов сценариев, ключ → CSS/testid-селектор. */
  selectors?: Record<string, string>;
  mail_provider?: "mailpit" | "mailhog";
  password_policy?: { minLength?: number; upper?: boolean; lower?: boolean; digits?: boolean; symbols?: boolean };
  ignore_https_errors?: boolean;
  keep_fixtures?: boolean;
  [key: string]: unknown;
}

export interface Scenario {
  key: string;
  name: string;
  tags?: string[];
  run(ctx: ScenarioContext): Promise<void>;
}
