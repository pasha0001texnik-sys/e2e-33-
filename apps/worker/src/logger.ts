import { maskSecrets, redactText, type LogLevel } from "@e2e/shared";
import type { Db } from "./db.ts";

interface Pending {
  run_id: string;
  run_test_id: string | null;
  level: LogLevel;
  message: string;
  data: Record<string, unknown> | null;
  ts: string;
}

/**
 * Лог прогона: батчами пишет в run_logs (оттуда UI получает его через Realtime)
 * и дублирует в stdout с trace_id. Известные секреты вырезаются из текста.
 */
export class RunLogger {
  private buf: Pending[] = [];
  private timer: NodeJS.Timeout;
  private secrets = new Set<string>();

  constructor(
    private db: Db,
    private runId: string,
    private traceId: string,
  ) {
    this.timer = setInterval(() => void this.flush(), 1000);
  }

  addSecret(...values: (string | undefined | null)[]) {
    for (const v of values) if (v) this.secrets.add(v);
  }

  redact(text: string): string {
    return redactText(text, this.secrets);
  }

  for(testId: string | null) {
    return {
      debug: (m: string, d?: Record<string, unknown>) => this.write("debug", m, d, testId),
      info: (m: string, d?: Record<string, unknown>) => this.write("info", m, d, testId),
      warn: (m: string, d?: Record<string, unknown>) => this.write("warn", m, d, testId),
      error: (m: string, d?: Record<string, unknown>) => this.write("error", m, d, testId),
    };
  }

  write(level: LogLevel, message: string, data?: Record<string, unknown>, testId: string | null = null) {
    const msg = this.redact(message);
    let safeData: Record<string, unknown> | null = null;
    if (data) {
      const masked = maskSecrets(data);
      try {
        safeData = JSON.parse(this.redact(JSON.stringify(masked))) as Record<string, unknown>;
      } catch {
        safeData = { note: "данные скрыты: не удалось безопасно вырезать секреты" };
      }
    }
    this.buf.push({ run_id: this.runId, run_test_id: testId, level, message: msg, data: safeData, ts: new Date().toISOString() });
    const line = JSON.stringify({ level, trace_id: this.traceId, run_id: this.runId, test_id: testId, msg, ...(safeData ?? {}) });
    (level === "error" ? console.error : console.log)(line);
  }

  async flush() {
    if (!this.buf.length) return;
    const batch = this.buf.splice(0, this.buf.length);
    const { error } = await this.db.from("run_logs").insert(batch);
    if (error) console.error(JSON.stringify({ level: "error", msg: "run_logs insert failed", error: error.message }));
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

/** Лог процесса воркера (вне прогона). */
export const sysLog = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", msg, ...data })),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(JSON.stringify({ level: "warn", msg, ...data })),
  error: (msg: string, data?: Record<string, unknown>) => console.error(JSON.stringify({ level: "error", msg, ...data })),
};
