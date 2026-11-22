// Каталог сценариев воркера (метаданные). Реализации — apps/worker/src/scenarios.
// Веб-панель показывает этот список при редактировании сюитов.

export interface ScenarioInfo {
  key: string;
  name: string;
  tags: string[];
}

export const SCENARIO_CATALOG: ScenarioInfo[] = [
  { key: "signup.email", name: "Регистрация по email", tags: ["smoke", "auth"] },
  { key: "signup.verify-email", name: "Регистрация и подтверждение почты", tags: ["auth", "email"] },
  { key: "login.password", name: "Вход по паролю", tags: ["smoke", "auth"] },
  { key: "login.wrong-password", name: "Вход с неверным паролем показывает ошибку", tags: ["auth", "negative"] },
  { key: "onboarding.profile", name: "Онбординг: анкета после регистрации", tags: ["onboarding"] },
];
