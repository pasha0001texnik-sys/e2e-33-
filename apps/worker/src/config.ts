import { hostname } from "node:os";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),
  WORKER_MAX_RUNS: z.coerce.number().int().min(1).max(20).default(1),
  /** Какие стенды обслуживает воркер: web (Playwright) и/или android, ios (Appium) */
  WORKER_PLATFORMS: z
    .string()
    .default("web")
    .transform((v) => [...new Set(v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.enum(["web", "android", "ios"])).min(1, "WORKER_PLATFORMS: укажите web, android или ios")),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  HEADLESS: bool(true),
  /** Путь к Chrome/Chromium, если не используется браузер из образа Playwright */
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  ENABLE_SCHEDULER: bool(true),
  ENABLE_JANITOR: bool(true),
  HOLD_TIMEOUT_SEC: z.coerce.number().int().min(30).max(7200).default(900),
  /** off | on-failure | on — трейсы Playwright сохраняют ввод в поля, храните их только в приватном бакете */
  TRACE_MODE: z.enum(["off", "on-failure", "on"]).default("on-failure"),
  ARTIFACTS_BUCKET: z.string().default("artifacts"),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().default(10000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Некорректные переменные окружения воркера:\n${issues}`);
  }
  return parsed.data;
}
