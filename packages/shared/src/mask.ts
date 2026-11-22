// Маскирование секретов в логах, экспорте и аудите.

const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|otp|code$|session/i;

export function maskValue(v: string): string {
  if (v.length <= 4) return "****";
  return v.slice(0, 2) + "****";
}

/** Рекурсивно маскирует значения по именам ключей. */
export function maskSecrets<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? maskValue(v) : maskSecrets(v, depth + 1);
  }
  return out as T;
}

/** Заменяет известные секретные строки в произвольном тексте. */
export function redactText(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("****");
  }
  // Bearer-токены и пароли в query-строках
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1****")
    .replace(/([?&](?:password|token|code|secret)=)[^&\s]+/gi, "$1****");
}
