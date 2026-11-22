import type { RunStatus, RunSummary, TestStatus } from "./types.ts";

export function summarize(tests: { status: TestStatus; duration_ms?: number | null }[]): RunSummary {
  const s: Required<RunSummary> = { total: tests.length, passed: 0, flaky: 0, failed: 0, skipped: 0, cancelled: 0, duration_ms: 0 };
  for (const t of tests) {
    if (t.status === "passed") s.passed++;
    else if (t.status === "flaky") s.flaky++;
    else if (t.status === "failed") s.failed++;
    else if (t.status === "skipped") s.skipped++;
    else if (t.status === "cancelled") s.cancelled++;
    s.duration_ms += t.duration_ms ?? 0;
  }
  return s;
}

/** Итоговый статус прогона. flaky не роняет прогон, но виден в сводке. */
export function finalRunStatus(summary: RunSummary, cancelled: boolean): RunStatus {
  if (cancelled) return "cancelled";
  if ((summary.failed ?? 0) > 0) return "failed";
  return "passed";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${s % 60} с`;
}
