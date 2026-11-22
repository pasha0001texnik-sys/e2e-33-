// Конфигурация и валидация источника проверочных кодов (code_provider).
// Браузеробезопасно: типы + чистый валидатор, используется в веб-форме и воркере.
// Рантайм-реализация провайдера (HTTP-опрос) — в apps/worker/src/codes.ts.

import { requestHostStatus } from "./guard.ts";

/** Извлечение кода из ответа источника. */
export interface CodeExtract {
  /** Регэксп; берётся первая группа, иначе всё совпадение. */
  regex?: string;
  /** Точное поле JSON-ответа по dot-пути, например "data.code". Может сочетаться с regex. */
  field?: string;
}

/** Конфигурация источника кодов (хранится в stand.test_flags.code_provider). */
export interface CodeProviderConfig {
  /** Базовый URL источника в пределах allowlist стенда */
  url: string;
  /** Шаблон пути запроса; {id} подставляется (URL-экранируется). По умолчанию "{id}". */
  path?: string;
  method?: "GET" | "POST";
  /** Имя секрета стенда с токеном (Bearer). Значение берётся из Vault. */
  token_secret?: string;
  release_path?: string;
  release_method?: "DELETE" | "POST";
  extract?: CodeExtract;
  timeout_ms?: number;
  poll_interval_ms?: number;
  request_timeout_ms?: number;
}

export const DEFAULT_CODE_REGEX = "\\b(\\d{4,8})\\b";

/** Сырые строковые поля из формы редактирования стенда. */
export interface CodeProviderInput {
  url?: string;
  path?: string;
  method?: string;
  token_secret?: string;
  extract_field?: string;
  extract_regex?: string;
  timeout_ms?: string;
  poll_interval_ms?: string;
  request_timeout_ms?: string;
  release_path?: string;
  release_method?: string;
}

export interface BuildCodeProviderResult {
  /** null — источник не задан (url пуст) или была ошибка (см. error). */
  config: CodeProviderConfig | null;
  error?: string;
}

const RANGES = {
  timeout_ms: [1000, 600000],
  poll_interval_ms: [250, 60000],
  request_timeout_ms: [1000, 120000],
} as const;

/**
 * Собирает и валидирует CodeProviderConfig из полей формы.
 * Ключевая проверка границы: хост url обязан быть в allowed_hosts и не в
 * forbidden_hosts; путь/release — относительные (не меняют хост). Так источник
 * кодов остаётся сервисом тестового контура, egress-allowlist не расширяется.
 */
export function buildCodeProvider(
  input: CodeProviderInput,
  allowedHosts: readonly string[],
  forbiddenPatterns: readonly string[] = [],
): BuildCodeProviderResult {
  const url = (input.url ?? "").trim();
  if (!url) return { config: null }; // источник не настроен

  const path = (input.path ?? "").trim();
  const releasePath = (input.release_path ?? "").trim();
  if (/:\/\//.test(path) || /:\/\//.test(releasePath)) {
    return { config: null, error: "Путь источника кодов должен быть относительным (без http/https)" };
  }

  const status = requestHostStatus(url, allowedHosts, forbiddenPatterns);
  if (status === "invalid") return { config: null, error: "Некорректный URL источника кодов" };
  if (status === "forbidden") return { config: null, error: "Хост источника кодов в списке запрещённых" };
  if (status !== "ok") return { config: null, error: "Хост источника кодов вне allowlist стенда" };

  const regex = (input.extract_regex ?? "").trim();
  if (regex) {
    try {
      new RegExp(regex);
    } catch {
      return { config: null, error: "Некорректное регулярное выражение для кода" };
    }
  }

  const nums: Partial<Record<keyof typeof RANGES, number>> = {};
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const raw = (input[key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    const [lo, hi] = RANGES[key];
    if (!Number.isInteger(n) || n < lo || n > hi) {
      return { config: null, error: `Значение ${key} должно быть целым в диапазоне ${lo}–${hi} мс` };
    }
    nums[key] = n;
  }

  const method = input.method === "POST" ? "POST" : "GET";
  const releaseMethod = input.release_method === "POST" ? "POST" : "DELETE";
  const field = (input.extract_field ?? "").trim();

  const config: CodeProviderConfig = { url };
  if (path) config.path = path;
  if (method !== "GET") config.method = method;
  if (input.token_secret?.trim()) config.token_secret = input.token_secret.trim();
  const extract: CodeExtract = {};
  if (field) extract.field = field;
  if (regex) extract.regex = regex;
  if (Object.keys(extract).length) config.extract = extract;
  if (nums.timeout_ms) config.timeout_ms = nums.timeout_ms;
  if (nums.poll_interval_ms) config.poll_interval_ms = nums.poll_interval_ms;
  if (nums.request_timeout_ms) config.request_timeout_ms = nums.request_timeout_ms;
  if (releasePath) {
    config.release_path = releasePath;
    if (releaseMethod !== "DELETE") config.release_method = releaseMethod;
  }
  return { config };
}
