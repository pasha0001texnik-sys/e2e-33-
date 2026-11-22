// Запись артефакта результата сценария в реестр run_results.
// Изолированный модуль: вызывается из раннера, но не влияет на исход теста
// (вызывающий оборачивает в try/catch). Логику выполнения не меняет.

import { DEFAULT_NET_PROFILE, maskSecrets, type BrowserProfile, type NetProfile, type NetworkProfile, type Run, type RunTest, type Stand, type TestStatus } from "@e2e/shared";
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
  /** Применённый профиль гео-/сетевой эмуляции; пишется в network_profile + region */
  netProfile?: NetProfile;
}

/**
 * Собирает поля формы из фикстур этого выполнения. Открытые поля (имя, фамилия,
 * дата рождения, пол, логин, email) читаются как есть; пароль маскируется
 * (maskSecrets маскирует только ключ password). Реальный пароль остаётся в
 * защищённой secret_payload — его раскрывает только экспорт с флагом секретов.
 */
export async function recordResult(db: Db, input: RecordResultInput): Promise<void> {
  const { run, stand, test, status, error, storageDump, browserProfile, netProfile } = input;
  const flags = stand.test_flags as StandFlags & { region?: string; network_profile?: NetworkProfile };

  const { data: fx } = await db.from("fixtures").select("payload, secret_payload").eq("run_test_id", test.id);
  const formFields: Record<string, unknown> = {};
  for (const row of (fx ?? []) as { payload: Record<string, unknown>; secret_payload: Record<string, unknown> }[]) {
    Object.assign(formFields, row.payload, row.secret_payload);
  }

  // База — свободные поля network_profile из флагов стенда, затем применённый браузерный профиль
  const networkProfile: NetworkProfile = { ...(flags.network_profile ?? {}) };
  if (browserProfile) networkProfile.browser = browserProfile;

  // Применённый профиль эмуляции: ключ, сетевые условия и гео — в метаданные результата.
  // region берётся из подписи гео-профиля, иначе — из флагов стенда / окружения.
  let region = flags.region ?? stand.env;
  if (netProfile && netProfile.key !== DEFAULT_NET_PROFILE) {
    networkProfile.net_profile = netProfile.key;
    const n = netProfile.network;
    if (n) {
      if (n.offline != null) networkProfile.offline = n.offline;
      if (n.download != null) networkProfile.download = n.download;
      if (n.upload != null) networkProfile.upload = n.upload;
      if (n.latency != null) networkProfile.latency = n.latency;
    }
    if (netProfile.geo) {
      const g = netProfile.geo;
      networkProfile.geo = { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 20, region: g.region };
      if (g.region) region = g.region;
    }
  }

  await db.rpc("worker_record_result", {
    p_run: run.id,
    p_test: test.id,
    p_scenario: test.scenario_key,
    p_status: status,
    // открытые поля как есть, пароль маскируется
    p_form_fields: maskSecrets(formFields),
    p_network_profile: networkProfile,
    p_region: region,
    p_error: error,
    p_storage_dump: storageDump ?? {},
  });
}
