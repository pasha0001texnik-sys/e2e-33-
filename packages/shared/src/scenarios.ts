// Каталог сценариев воркера (метаданные). Реализации — apps/worker/src/scenarios.
// Веб-панель показывает этот список при редактировании сюитов.

import type { Platform } from "./types.ts";

export interface ScenarioInfo {
  key: string;
  name: string;
  tags: string[];
  /** Сценарии, которые должны пройти раньше; их фикстуры передаются этому сценарию */
  dependsOn: string[];
  /** На каких платформах стендов сценарий умеет работать */
  platforms: Platform[];
}

export const SCENARIO_CATALOG: ScenarioInfo[] = [
  { key: "signup.email", name: "Регистрация по email", tags: ["smoke", "auth"], dependsOn: [], platforms: ["web", "android", "ios"] },
  { key: "signup.verify-email", name: "Регистрация и подтверждение почты", tags: ["auth", "email"], dependsOn: [], platforms: ["web", "android", "ios"] },
  { key: "login.password", name: "Вход по паролю", tags: ["smoke", "auth"], dependsOn: [], platforms: ["web", "android", "ios"] },
  { key: "login.wrong-password", name: "Вход с неверным паролем показывает ошибку", tags: ["auth", "negative"], dependsOn: [], platforms: ["web", "android", "ios"] },
  {
    key: "onboarding.profile",
    name: "Онбординг: анкета после регистрации",
    tags: ["onboarding"],
    dependsOn: ["signup.verify-email"],
    platforms: ["web"],
  },
  {
    key: "login.after-onboarding",
    name: "Повторный вход после онбординга ведёт в продукт",
    tags: ["onboarding", "auth"],
    dependsOn: ["onboarding.profile"],
    platforms: ["web"],
  },
  {
    key: "e2e.full-signup",
    name: "Сквозной сценарий: регистрация → код → вход",
    tags: ["e2e", "smoke", "auth"],
    dependsOn: [],
    platforms: ["web"],
  },
];

const BY_KEY = new Map(SCENARIO_CATALOG.map((s) => [s.key, s]));

/** Ключи сценариев вместе со всеми их зависимостями, в порядке выполнения (зависимости раньше). */
export function withDependencies(keys: readonly string[], lookup: (key: string) => { dependsOn: string[] } | undefined = (k) => BY_KEY.get(k)): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") throw new Error(`Циклическая зависимость сценариев: ${[...path, key].join(" → ")}`);
    state.set(key, "visiting");
    for (const dep of lookup(key)?.dependsOn ?? []) visit(dep, [...path, key]);
    state.set(key, "done");
    out.push(key);
  };
  for (const k of keys) visit(k, []);
  return out;
}
