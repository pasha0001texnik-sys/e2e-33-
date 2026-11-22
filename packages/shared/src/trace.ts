// Сквозная трассировка: один trace_id от панели и очереди до логов воркера и событий стенда.
// Стенд получает его в заголовках каждого запроса и может писать в свои логи.

export const TRACE_HEADER = "x-e2e-trace-id";
export const RUN_HEADER = "x-e2e-run-id";
export const TEST_HEADER = "x-e2e-test-id";

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** W3C traceparent из trace_id прогона (uuid → 32 hex), новый span на каждый вызов. */
export function traceparent(traceId: string): string {
  const id = traceId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id) || /^0+$/.test(id)) throw new Error(`Некорректный trace_id: ${traceId}`);
  return `00-${id}-${randomHex(8)}-01`;
}

/** Заголовки, которые воркер добавляет к запросам на стенд. */
export function traceHeaders(ids: { traceId: string; runId: string; testId?: string }): Record<string, string> {
  return {
    [TRACE_HEADER]: ids.traceId,
    [RUN_HEADER]: ids.runId,
    ...(ids.testId ? { [TEST_HEADER]: ids.testId } : {}),
  };
}
