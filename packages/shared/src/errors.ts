// Классификация ошибок: ретраим только инфраструктурные сбои.
// Упавшая проверка (assertion) — это дефект или сломанный тест, повтор его маскирует.

import type { ErrorKind } from "./types.ts";

const INFRA_PATTERNS = [
  /net::ERR_/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i,
  /Target (page, context or browser|closed)/i,
  /browser has been closed|Browser closed|crashed/i,
  /Navigation failed because page crashed/i,
  /\b50[234]\b.*(Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /stand unavailable|стенд недоступен/i,
];

export function classifyError(err: unknown): ErrorKind {
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);
  if (name === "GuardError") return "guard";
  if (name === "CancelledError") return "cancelled";
  if (name === "InfraError") return "infra";
  if (INFRA_PATTERNS.some((re) => re.test(msg))) return "infra";
  if (name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(msg)) {
    // таймаут навигации — скорее стенд, таймаут ожидания элемента — скорее тест
    return /page\.goto|navigation|waiting for (load|navigation)/i.test(msg) ? "infra" : "timeout";
  }
  return "assertion";
}

export function isRetryable(kind: ErrorKind): boolean {
  return kind === "infra";
}

export class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Прогон отменён") {
    super(message);
    this.name = "CancelledError";
  }
}
