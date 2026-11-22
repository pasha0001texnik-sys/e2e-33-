// Запись артефакта результата сценария в реестр run_results.
// Изолированный модуль: вызывается из раннера, но не влияет на исход теста
// (вызывающий оборачивает в try/catch). Логику выполнения не меняет.

import { maskSecrets, type BrowserProfile, type NetworkProfile, type Run, type RunTest, type Stand, type TestStatus } from "@e2e/shared";
import type { Db } from "./db.ts";
import type { StandFlags } from "./scenarios/types.ts";

export interface RecordResultInput {
  run: Run;
  stand: Stand;
  test: RunTest;
  status: TestStatus;
  error: string | null;
  /** Дамп cookies/localStorage, если захват включён флагом стенда; иначе null */
  storageDump: Record<string, unknown> | null;
  /** Применённый браузерный профиль (web); пишется в network_profile.browser */
  browserProfile?: BrowserProfile;
}

/**
 * Собирает поля формы из фикстур этого выполнения. Открытые поля (имя, фамилия,
 * дата рождения, пол, логин, email) читаются как есть; пароль маскируется
 * (maskSecrets маскирует только ключ password). Реальный пароль остаётся в
 * защищённой secret_payload — его раскрывает только экспорт с флагом секретов.
 */
export async function recordResult(db: Db, input: RecordResultInput): Promise<void> {
  const { run, stand, test, status, error, storageDump, browserProfile } = input;
  const flags = stand.test_flags as StandFlags & { region?: string; network_profile?: NetworkProfile };

  const { data: fx } = await db.from("fixtures").select("payload, secret_payload").eq("run_test_id", test.id);
  const formFields: Record<string, unknown> = {};
  for (const row of (fx ?? []) as { payload: Record<string, unknown>; secret_payload: Record<string, unknown> }[]) {
    Object.assign(formFields, row.payload, row.secret_payload);
  }

  const networkProfile: NetworkProfile = { ...(flags.network_profile ?? {}) };
  if (browserProfile) networkProfile.browser = browserProfile;

  await db.rpc("worker_record_result", {
    p_run: run.id,
    p_test: test.id,
    p_scenario: test.scenario_key,
    p_status: status,
    // открытые поля как есть, пароль маскируется
    p_form_fields: maskSecrets(formFields),
    p_network_profile: networkProfile,
    p_region: flags.region ?? stand.env,
    p_error: error,
    p_storage_dump: storageDump ?? {},
  });
}
