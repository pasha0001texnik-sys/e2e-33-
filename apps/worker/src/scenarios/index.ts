// Реестр сценариев. Ключи используются в suites.scenario_keys.
// Чтобы добавить сценарий: создайте объект Scenario и добавьте его в SCENARIOS.

import { expect } from "@playwright/test";
import { logIn, path, sel, signUp, verifiedUser, verifyEmail } from "./flows.ts";
import type { Scenario } from "./types.ts";

export const SCENARIOS: Scenario[] = [
  {
    key: "signup.email",
    name: "Регистрация по email",
    tags: ["smoke", "auth"],
    async run(ctx) {
      const user = await ctx.fixtures.createUser();
      await signUp(ctx, user);
    },
  },
  {
    key: "signup.verify-email",
    name: "Регистрация и подтверждение почты",
    tags: ["auth", "email"],
    async run(ctx) {
      const user = await ctx.fixtures.createUser();
      const since = new Date(Date.now() - 5000);
      await signUp(ctx, user);
      await verifyEmail(ctx, user, since);
    },
  },
  {
    key: "login.password",
    name: "Вход по паролю",
    tags: ["smoke", "auth"],
    async run(ctx) {
      const user = await verifiedUser(ctx);
      await logIn(ctx, user.email, user.password);
      await ctx.step("Проверить, что пользователь вошёл", async () => {
        await expect(ctx.page.locator(sel(ctx, "app.user_menu"))).toBeVisible({ timeout: 20000 });
      });
    },
  },
  {
    key: "login.wrong-password",
    name: "Вход с неверным паролем показывает ошибку",
    tags: ["auth", "negative"],
    async run(ctx) {
      const user = await verifiedUser(ctx);
      await logIn(ctx, user.email, user.password + "x");
      await ctx.step("Проверить сообщение об ошибке", async () => {
        await expect(ctx.page.locator(sel(ctx, "login.error"))).toBeVisible({ timeout: 15000 });
        await expect(ctx.page.locator(sel(ctx, "app.user_menu"))).toHaveCount(0);
      });
    },
  },
  {
    key: "onboarding.profile",
    name: "Онбординг: анкета после регистрации",
    tags: ["onboarding"],
    async run(ctx) {
      const user = await verifiedUser(ctx);
      await logIn(ctx, user.email, user.password);
      await ctx.step("Открыть онбординг", async () => {
        if (!ctx.page.url().includes(path(ctx, "onboarding"))) await ctx.page.goto(path(ctx, "onboarding"));
        await expect(ctx.page.locator(sel(ctx, "onboarding.company"))).toBeVisible({ timeout: 20000 });
      });
      await ctx.step("Заполнить анкету", async () => {
        await ctx.page.locator(sel(ctx, "onboarding.company")).fill(`E2E ${user.last_name}`);
        const role = ctx.page.locator(sel(ctx, "onboarding.role"));
        if (await role.count()) {
          const tag = await role.evaluate((el) => el.tagName.toLowerCase());
          if (tag === "select") await role.selectOption({ index: 1 });
          else await role.fill("QA");
        }
        const next = ctx.page.locator(sel(ctx, "onboarding.next"));
        if (await next.count()) await next.click();
      });
      await ctx.step("Завершить онбординг", async () => {
        await ctx.page.locator(sel(ctx, "onboarding.finish")).click();
        await expect(ctx.page.locator(sel(ctx, "onboarding.done"))).toBeVisible({ timeout: 20000 });
      });
    },
  },
];

const byKey = new Map(SCENARIOS.map((s) => [s.key, s]));

export function getScenario(key: string): Scenario | undefined {
  return byKey.get(key);
}

export function listScenarios() {
  return SCENARIOS.map(({ key, name, tags }) => ({ key, name, tags: tags ?? [] }));
}
