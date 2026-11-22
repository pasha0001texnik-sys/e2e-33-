// Реестр сценариев. Ключи используются в suites.scenario_keys.
// Чтобы добавить сценарий: создайте объект Scenario и добавьте его в SCENARIOS.

import { expect } from "@playwright/test";
import { logIn, path, sel, signUp, userFromDependency, verifiedUser, verifyByCodeProvider, verifyEmail } from "./flows.ts";
import * as mobile from "./mobile.ts";
import type { Scenario, StandFlags } from "./types.ts";

export const SCENARIOS: Scenario[] = [
  {
    key: "signup.email",
    name: "Регистрация по email",
    tags: ["smoke", "auth"],
    async run(ctx) {
      const user = await ctx.fixtures.createUser();
      await signUp(ctx, user);
    },
    async runMobile(ctx) {
      const user = await ctx.fixtures.createUser();
      await mobile.signUp(ctx, user);
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
      ctx.share("user", user.id); // подтверждённый пользователь — для зависимых сценариев
    },
    async runMobile(ctx) {
      const user = await ctx.fixtures.createUser();
      const since = new Date(Date.now() - 5000);
      await mobile.signUp(ctx, user);
      await mobile.verifyEmail(ctx, user, since);
      ctx.share("user", user.id);
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
    async runMobile(ctx) {
      const user = await mobile.verifiedUser(ctx);
      await mobile.logIn(ctx, user.email, user.password);
      await ctx.step("Проверить, что пользователь вошёл", () => mobile.waitVisible(ctx, "app.user_menu", 20000));
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
    async runMobile(ctx) {
      const user = await mobile.verifiedUser(ctx);
      await mobile.logIn(ctx, user.email, user.password + "x");
      await ctx.step("Проверить сообщение об ошибке", async () => {
        await mobile.waitVisible(ctx, "login.error", 15000);
        if (await mobile.isVisible(ctx, "app.user_menu")) throw new Error("С неверным паролем пользователь вошёл");
      });
    },
  },
  {
    key: "onboarding.profile",
    name: "Онбординг: анкета после регистрации",
    tags: ["onboarding"],
    dependsOn: ["signup.verify-email"],
    async run(ctx) {
      const user = await userFromDependency(ctx, "signup.verify-email");
      await logIn(ctx, user.email, user.password);
      await ctx.step("Открыть онбординг", async () => {
        if (!ctx.page.url().includes(path(ctx, "onboarding"))) await ctx.page.goto(path(ctx, "onboarding"));
        await expect(ctx.page.locator(sel(ctx, "onboarding.company"))).toBeVisible({ timeout: 20000 });
      });
      await ctx.step("Заполнить анкету", async () => {
        await ctx.ui.fill(ctx.page.locator(sel(ctx, "onboarding.company")), `E2E ${user.last_name}`);
        const role = ctx.page.locator(sel(ctx, "onboarding.role"));
        if (await role.count()) {
          const tag = await role.evaluate((el) => el.tagName.toLowerCase());
          if (tag === "select") await role.selectOption({ index: 1 });
          else await ctx.ui.fill(role, "QA");
        }
        const next = ctx.page.locator(sel(ctx, "onboarding.next"));
        if (await next.count()) await ctx.ui.click(next);
      });
      await ctx.step("Завершить онбординг", async () => {
        await ctx.ui.click(ctx.page.locator(sel(ctx, "onboarding.finish")));
        await expect(ctx.page.locator(sel(ctx, "onboarding.done"))).toBeVisible({ timeout: 20000 });
      });
      ctx.share("user", user.id); // пользователь с пройденным онбордингом
    },
  },
  {
    key: "login.after-onboarding",
    name: "Повторный вход после онбординга ведёт в продукт",
    tags: ["onboarding", "auth"],
    dependsOn: ["onboarding.profile"],
    async run(ctx) {
      const user = await userFromDependency(ctx, "onboarding.profile");
      await logIn(ctx, user.email, user.password);
      await ctx.step("Онбординг не показывается повторно", async () => {
        await expect(ctx.page.locator(sel(ctx, "app.user_menu"))).toBeVisible({ timeout: 20000 });
        await expect(ctx.page.locator(sel(ctx, "onboarding.company"))).toHaveCount(0);
      });
    },
  },
  {
    // Сквозной сценарий: объединяет fixture_template (данные), exec_profile (тайминги)
    // и net_profile (контекст) — применяются раннером — с подтверждением по коду из
    // источника (ctx.codes) или по письму, и фиксацией результата в run_results.
    key: "e2e.full-signup",
    name: "Сквозной сценарий: регистрация → код → вход",
    tags: ["e2e", "smoke", "auth"],
    async run(ctx) {
      const user = await ctx.fixtures.createUser();
      const since = new Date(Date.now() - 5000);
      await signUp(ctx, user);
      // Код из HTTP-источника, если настроен на стенде; иначе — подтверждение по письму
      const codeProvider = (ctx.stand.test_flags as StandFlags).code_provider;
      if (codeProvider?.url) await verifyByCodeProvider(ctx, user);
      else await verifyEmail(ctx, user, since);
      await logIn(ctx, user.email, user.password);
      await ctx.step("Проверить вход в продукт", async () => {
        await expect(ctx.page.locator(sel(ctx, "app.user_menu"))).toBeVisible({ timeout: 20000 });
      });
      ctx.share("user", user.id);
    },
  },
];

const byKey = new Map(SCENARIOS.map((s) => [s.key, s]));

export function getScenario(key: string): Scenario | undefined {
  return byKey.get(key);
}

export function listScenarios() {
  return SCENARIOS.map((s) => ({
    key: s.key,
    name: s.name,
    tags: s.tags ?? [],
    dependsOn: s.dependsOn ?? [],
    platforms: [...(s.run ? ["web"] : []), ...(s.runMobile ? ["android", "ios"] : [])],
  }));
}
