// Типы строк БД (повторяют supabase/migrations). Держите в синхроне со схемой
// или сгенерируйте: `supabase gen types typescript --linked`.

export const ROLES = ["viewer", "qa", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const STAND_ENVS = ["dev", "qa", "staging"] as const;
export type StandEnv = (typeof STAND_ENVS)[number];

export const PLATFORMS = ["web", "android", "ios"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type RunStatus = "queued" | "running" | "paused" | "passed" | "failed" | "cancelled" | "error";
export type RunTrigger = "manual" | "schedule" | "webhook" | "rerun";
export type TestStatus = "queued" | "running" | "on_hold" | "passed" | "flaky" | "failed" | "skipped" | "cancelled";
export type StepStatus = "running" | "passed" | "failed" | "skipped";
export type FixtureStatus = "created" | "verified" | "in_use" | "cleanup_pending" | "cleaned" | "failed" | "orphaned";
export type HoldAction = "continue" | "fail" | "abort";
export type OverlapPolicy = "skip" | "queue" | "cancel_previous";
export type ErrorKind = "infra" | "assertion" | "guard" | "timeout" | "cancelled";
export type LogLevel = "debug" | "info" | "warn" | "error";

export const TERMINAL_RUN_STATUSES: RunStatus[] = ["passed", "failed", "cancelled", "error"];

/** Приоритеты очереди: меньше — важнее. */
export const PRIORITY = { webhook: 10, rerun: 40, manual: 50, schedule: 100 } as const;

export interface QuietHours {
  tz?: string;
  from: string; // "10:00"
  to: string; // "19:00"
  days?: number[]; // ISO: 1 = пн ... 7 = вс
}

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  created_at: string;
}

export interface Stand {
  id: string;
  slug: string;
  name: string;
  env: StandEnv;
  platform: Platform;
  /** Appium-сервер для android/ios */
  appium_url: string | null;
  /** W3C capabilities мобильной сессии */
  capabilities: Record<string, unknown>;
  base_url: string;
  allowed_hosts: string[];
  health_url: string | null;
  expected_env_marker: string | null;
  mail_domain: string | null;
  mailbox_api_url: string | null;
  cleanup_api_url: string | null;
  max_concurrency: number;
  max_holds: number;
  rps_limit: number | null;
  quiet_hours: QuietHours | null;
  fixture_ttl_minutes: number;
  mocks: Record<string, unknown>;
  test_flags: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Suite {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  scenario_keys: string[];
  tags: string[];
  default_parallelism: number;
  max_retries: number;
  test_timeout_sec: number;
  created_at: string;
  updated_at: string;
}

export interface Schedule {
  id: string;
  suite_id: string;
  stand_id: string;
  cron: string;
  timezone: string;
  build_tag: string;
  overlap_policy: OverlapPolicy;
  parallelism: number | null;
  enabled: boolean;
  next_fire_at: string | null;
  last_fired_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  number: number;
  suite_id: string;
  stand_id: string;
  build_tag: string;
  status: RunStatus;
  trigger: RunTrigger;
  priority: number;
  parallelism: number;
  max_retries: number;
  only_scenarios: string[] | null;
  hold_on_failure: boolean;
  idempotency_key: string | null;
  parent_run_id: string | null;
  schedule_id: string | null;
  trace_id: string;
  created_by: string | null;
  worker_id: string | null;
  cancel_requested: boolean;
  pause_requested: boolean;
  summary: RunSummary;
  error: string | null;
  heartbeat_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunSummary {
  total?: number;
  passed?: number;
  flaky?: number;
  failed?: number;
  skipped?: number;
  cancelled?: number;
  duration_ms?: number;
}

export interface RunTest {
  id: string;
  run_id: string;
  scenario_key: string;
  name: string;
  status: TestStatus;
  attempt: number;
  max_attempts: number;
  flaky: boolean;
  error: string | null;
  error_kind: ErrorKind | null;
  duration_ms: number | null;
  trace_path: string | null;
  video_path: string | null;
  hold_requested: boolean;
  hold_step: string | null;
  hold_until: string | null;
  hold_action: HoldAction | null;
  hold_by: string | null;
  depends_on: string[];
  outputs: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunStep {
  id: number;
  run_id: string;
  run_test_id: string;
  attempt: number;
  idx: number;
  name: string;
  status: StepStatus;
  error: string | null;
  screenshot_path: string | null;
  dom_path: string | null;
  network_errors: NetworkError[];
  started_at: string;
  finished_at: string | null;
}

export interface NetworkError {
  url: string;
  method: string;
  status?: number;
  failure?: string;
}

export interface RunLog {
  id: number;
  run_id: string;
  run_test_id: string | null;
  ts: string;
  level: LogLevel;
  message: string;
  data: Record<string, unknown> | null;
}

export interface FixturePayload {
  email?: string;
  first_name?: string;
  last_name?: string;
  locale?: string;
  [key: string]: unknown;
}

export interface Fixture {
  id: string;
  stand_id: string;
  run_id: string | null;
  run_test_id: string | null;
  build_tag: string | null;
  kind: string;
  payload: FixturePayload;
  status: FixtureStatus;
  locked_by: string | null;
  expires_at: string;
  cleanup_attempts: number;
  last_error: string | null;
  cleaned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetworkProfile {
  /** Байт/с на скачивание (эмуляция throttling), null — без ограничения */
  download?: number | null;
  upload?: number | null;
  /** Доп. задержка, мс */
  latency?: number | null;
  offline?: boolean;
  user_agent?: string;
  [key: string]: unknown;
}

/** Артефакт выполнения одного сценария в прогоне. storage_dump виден только воркеру. */
export interface RunResult {
  id: string;
  run_id: string;
  run_test_id: string;
  scenario_key: string;
  status: TestStatus;
  /** Сгенерированные поля формы; секреты замаскированы */
  form_fields: Record<string, unknown>;
  network_profile: NetworkProfile;
  region: string | null;
  error: string | null;
  /** Дамп cookies/localStorage — не приходит в клиент через Data API */
  storage_dump?: Record<string, unknown>;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  data: Record<string, unknown> | null;
  at: string;
}
