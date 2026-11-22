// Общие шаги сценариев. Селекторы по умолчанию — data-testid; переопределяются
// в stand.test_flags.selectors, пути — в stand.test_flags.paths.

import { expect } from "@playwright/test";
import type { WaitCodeOptions } from "../codes.ts";
import type { UserFixture } from "../fixtures.ts";
import { Mailbox } from "../mail.ts";
import type { BaseContext, ScenarioContext } from "./types.ts";

const DEFAULT_PATHS = { signup: "/signup", login: "/login", onboarding: "/onboarding", home: "/", logout: "/logout" };

const DEFAULT_SELECTORS: Record<string, string> = {
  "signup.email": '[data-testid="signup-email"]',
  "signup.password": '[data-testid="signup-password"]',
  "signup.first_name": '[data-testid="signup-first-name"]',
  "signup.last_name": '[data-testid="signup-last-name"]',
  "signup.terms": '[data-testid="signup-terms"]',
  "signup.submit": '[data-testid="signup-submit"]',
  "signup.done": '[data-testid="signup-done"]',
  "verify.code": '[data-testid="verify-code"]',
  "verify.submit": '[data-testid="verify-submit"]',
  "verify.done": '[data-testid="verify-done"]',
  "login.email": '[data-testid="login-email"]',
  "login.password": '[data-testid="login-password"]',
  "login.submit": '[data-testid="login-submit"]',
  "login.error": '[data-testid="login-error"]',
  "app.user_menu": '[data-testid="user-menu"]',
  "onboarding.company": '[data-testid="onboarding-company"]',
  "onboarding.role": '[data-testid="onboarding-role"]',
  "onboarding.next": '[data-testid="onboarding-next"]',
  "onboarding.finish": '[data-testid="onboarding-finish"]',
  "onboarding.done": '[data-testid="onboarding-done"]',
};

export function path(ctx: ScenarioContext, key: keyof typeof DEFAULT_PATHS): string {
  return ctx.flags.paths?.[key] ?? DEFAULT_PATHS[key];
}

export function sel(ctx: ScenarioContext, key: string): string {
  const s = ctx.flags.selectors?.[key] ?? DEFAULT_SELECTORS[key];
  if (!s) throw new Error(`Нет селектора для "${key}"`);
  return s;
}

export async function signUp(ctx: ScenarioContext, user: UserFixture) {
  const { page } = ctx;
  await ctx.step("Открыть страницу регистрации", async () => {
    await page.goto(path(ctx, "signup"));
    await expect(page.locator(sel(ctx, "signup.email"))).toBeVisible();
  });
  await ctx.step("Заполнить форму регистрации", async () => {
    await ctx.ui.fill(page.locator(sel(ctx, "signup.email")), user.email);
    await ctx.ui.fill(page.locator(sel(ctx, "signup.password")), user.password);
    const first = page.locator(sel(ctx, "signup.first_name"));
    if (await first.count()) await ctx.ui.fill(first, user.first_name);
    const last = page.locator(sel(ctx, "signup.last_name"));
    if (await last.count()) await ctx.ui.fill(last, user.last_name);
    const terms = page.locator(sel(ctx, "signup.terms"));
    if (await terms.count()) await ctx.ui.check(terms);
  });
  await ctx.step("Отправить форму", async () => {
    await ctx.ui.click(page.locator(sel(ctx, "signup.submit")));
    await expect(page.locator(sel(ctx, "signup.done"))).toBeVisible({ timeout: 20000 });
  });
}

/** Подтверждение почты: ссылка или код из письма — что найдётся. */
export async function verifyEmail(ctx: ScenarioContext, user: UserFixture, since: Date) {
  const msg = await ctx.step("Дождаться письма с подтверждением", () =>
    ctx.mail.waitForMessage(user.email, { after: since, timeoutMs: 90000 }),
  );
  await ctx.step("Подтвердить почту", async () => {
    let link: string | null = null;
    try {
      link = ctx.mail.extractLink(msg, (ctx.flags.verify_link_contains as string | undefined) ?? "verif");
    } catch {
      link = null;
    }
    if (link) {
      await ctx.page.goto(link);
    } else {
      const code = Mailbox.extractCode(msg);
      await ctx.ui.fill(ctx.page.locator(sel(ctx, "verify.code")), code);
      await ctx.ui.click(ctx.page.locator(sel(ctx, "verify.submit")));
    }
    await expect(ctx.page.locator(sel(ctx, "verify.done"))).toBeVisible({ timeout: 20000 });
  });
  await ctx.fixtures.markVerified(user.id);
}

/**
 * Код подтверждения из HTTP-источника тестового контура (SMS/вебхук-синк) внутри
 * шага. Источник задаётся в stand.test_flags.code_provider; id — идентификатор
 * сессии/запроса (телефон, email, request id). При таймауте/ошибке шаг падает,
 * а причина попадает в run_steps → run_tests → run_results. Работает и для web,
 * и для мобильных сценариев.
 */
export async function getVerificationCode(ctx: BaseContext, id: string, opts?: WaitCodeOptions): Promise<string> {
  return ctx.step("Получить код подтверждения из источника", () => ctx.codes.waitForCode(id, opts));
}

export async function logIn(ctx: ScenarioContext, email: string, password: string) {
  const { page } = ctx;
  await ctx.step("Открыть страницу входа", async () => {
    await page.goto(path(ctx, "login"));
    await expect(page.locator(sel(ctx, "login.email"))).toBeVisible();
  });
  await ctx.step("Ввести учётные данные", async () => {
    await ctx.ui.fill(page.locator(sel(ctx, "login.email")), email);
    await ctx.ui.fill(page.locator(sel(ctx, "login.password")), password);
    await ctx.ui.click(page.locator(sel(ctx, "login.submit")));
  });
}

/** Готовый подтверждённый пользователь: берём из реестра или регистрируем нового. */
export async function verifiedUser(ctx: ScenarioContext): Promise<UserFixture> {
  const existing = await ctx.fixtures.claimUser();
  if (existing) {
    ctx.log(`Взят готовый пользователь из реестра: ${existing.email}`);
    return existing;
  }
  const user = await ctx.fixtures.createUser();
  const since = new Date(Date.now() - 5000);
  await signUp(ctx, user);
  await verifyEmail(ctx, user, since);
  return user;
}

/**
 * Пользователь, которого передал тест-зависимость (ключ "user").
 * Если зависимость ничего не передала или фикстуру уже занял другой тест — готовим своего.
 */
export async function userFromDependency(ctx: ScenarioContext, dependency: string): Promise<UserFixture> {
  const id = ctx.fromDependency(dependency, "user");
  if (id) {
    const user = await ctx.fixtures.adopt(id);
    if (user) {
      ctx.log(`Пользователь получен от «${dependency}»: ${user.email}`);
      return user;
    }
    ctx.log(`Фикстура от «${dependency}» недоступна, готовлю своего пользователя`);
  }
  return verifiedUser(ctx);
}
