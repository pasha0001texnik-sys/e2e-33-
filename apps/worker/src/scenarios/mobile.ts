// Шаги мобильных сценариев (Appium через webdriverio).
// Селекторы по умолчанию — accessibility id ("~signup-email"): в React Native это testID,
// в Android — content-description, в iOS — accessibilityIdentifier.
// Переопределяются в stand.test_flags.selectors так же, как для web.

import type { UserFixture } from "../fixtures.ts";
import { Mailbox } from "../mail.ts";
import type { MobileScenarioContext } from "./types.ts";

const DEFAULTS: Record<string, string> = {
  "nav.signup": "~nav-signup",
  "nav.login": "~nav-login",
  "signup.email": "~signup-email",
  "signup.password": "~signup-password",
  "signup.first_name": "~signup-first-name",
  "signup.submit": "~signup-submit",
  "signup.done": "~signup-done",
  "verify.code": "~verify-code",
  "verify.submit": "~verify-submit",
  "verify.done": "~verify-done",
  "login.email": "~login-email",
  "login.password": "~login-password",
  "login.submit": "~login-submit",
  "login.error": "~login-error",
  "app.user_menu": "~user-menu",
};

export function sel(ctx: MobileScenarioContext, key: string): string {
  const s = ctx.flags.selectors?.[`mobile.${key}`] ?? ctx.flags.selectors?.[key] ?? DEFAULTS[key];
  if (!s) throw new Error(`Нет мобильного селектора для "${key}"`);
  return s;
}

const el = (ctx: MobileScenarioContext, key: string) => ctx.driver.$(sel(ctx, key));

export async function waitVisible(ctx: MobileScenarioContext, key: string, timeout = 15000) {
  await el(ctx, key).waitForDisplayed({ timeout, timeoutMsg: `Элемент «${key}» (${sel(ctx, key)}) не появился за ${timeout} мс` });
}

export async function isVisible(ctx: MobileScenarioContext, key: string): Promise<boolean> {
  const e = el(ctx, key);
  return (await e.isExisting()) && (await e.isDisplayed());
}

async function fill(ctx: MobileScenarioContext, key: string, value: string) {
  const e = el(ctx, key);
  await e.waitForDisplayed({ timeoutMsg: `Поле «${key}» не появилось` });
  await ctx.ui.fill(e as unknown as WebdriverIO.Element, value);
}

async function tap(ctx: MobileScenarioContext, key: string) {
  const e = el(ctx, key);
  await e.waitForDisplayed({ timeoutMsg: `Кнопка «${key}» не появилась` });
  await ctx.ui.tap(e as unknown as WebdriverIO.Element);
}

/** Если на стартовом экране есть переход к форме — нажимаем его. */
async function openForm(ctx: MobileScenarioContext, nav: string, field: string) {
  if (await isVisible(ctx, field)) return;
  if (await isVisible(ctx, nav)) await tap(ctx, nav);
  await waitVisible(ctx, field, 20000);
}

export async function signUp(ctx: MobileScenarioContext, user: UserFixture) {
  await ctx.step("Открыть экран регистрации", () => openForm(ctx, "nav.signup", "signup.email"));
  await ctx.step("Заполнить форму регистрации", async () => {
    await fill(ctx, "signup.email", user.email);
    await fill(ctx, "signup.password", user.password);
    if (await isVisible(ctx, "signup.first_name")) await fill(ctx, "signup.first_name", user.first_name);
  });
  await ctx.step("Отправить форму", async () => {
    await tap(ctx, "signup.submit");
    await waitVisible(ctx, "signup.done", 20000);
  });
}

/** Подтверждение почты в приложении: код из письма, иначе — диплинк из письма. */
export async function verifyEmail(ctx: MobileScenarioContext, user: UserFixture, since: Date) {
  const msg = await ctx.step("Дождаться письма с подтверждением", () =>
    ctx.mail.waitForMessage(user.email, { after: since, timeoutMs: 90000 }),
  );
  await ctx.step("Подтвердить почту", async () => {
    let code: string | null = null;
    try {
      code = Mailbox.extractCode(msg);
    } catch {
      code = null;
    }
    if (code && (await isVisible(ctx, "verify.code"))) {
      await fill(ctx, "verify.code", code);
      await tap(ctx, "verify.submit");
    } else {
      // ссылка проверяется по allowlist стенда в extractLink
      await ctx.driver.url(ctx.mail.extractLink(msg, (ctx.flags.verify_link_contains as string | undefined) ?? "verif"));
    }
    await waitVisible(ctx, "verify.done", 20000);
  });
  await ctx.fixtures.markVerified(user.id);
}

export async function logIn(ctx: MobileScenarioContext, email: string, password: string) {
  await ctx.step("Открыть экран входа", () => openForm(ctx, "nav.login", "login.email"));
  await ctx.step("Ввести учётные данные", async () => {
    await fill(ctx, "login.email", email);
    await fill(ctx, "login.password", password);
    await tap(ctx, "login.submit");
  });
}

/** Подтверждённый пользователь: из реестра или новый. После регистрации приложение перезапускается. */
export async function verifiedUser(ctx: MobileScenarioContext): Promise<UserFixture> {
  const existing = await ctx.fixtures.claimUser();
  if (existing) {
    ctx.log(`Взят готовый пользователь из реестра: ${existing.email}`);
    return existing;
  }
  const user = await ctx.fixtures.createUser();
  const since = new Date(Date.now() - 5000);
  await signUp(ctx, user);
  await verifyEmail(ctx, user, since);
  await ctx.step("Перезапустить приложение", () => ctx.driver.reloadSession());
  return user;
}
