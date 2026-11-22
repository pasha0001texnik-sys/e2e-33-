// Защита от запуска против production.
// Работает в трёх местах: при сохранении стенда (UI + триггер БД), перед стартом прогона
// и на каждом сетевом запросе браузера в воркере.

import { STAND_ENVS, type StandEnv } from "./types.ts";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** Хост из URL в нижнем регистре; null, если URL невалиден. */
export function hostOf(url: string): string | null {
  try {
    // IPv6 остаётся в скобках, как в allowlist и в SQL-функции url_host
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Точное совпадение или шаблон вида "*.staging.example.test" (поддомены, без апекса). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (p.startsWith("*.")) return h.endsWith("." + p.slice(2));
  return h === p;
}

export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatches(host, p));
}

/** Пересекаются ли два шаблона (используется для проверки запрещённых хостов). */
export function patternsOverlap(a: string, b: string): boolean {
  const probe = (p: string) => (p.startsWith("*.") ? "x." + p.slice(2) : p);
  return hostMatches(probe(a), b) || hostMatches(probe(b), a) || a.toLowerCase() === b.toLowerCase();
}

export interface GuardStand {
  slug: string;
  env: string;
  base_url: string;
  allowed_hosts: readonly string[];
  health_url?: string | null;
  mailbox_api_url?: string | null;
  cleanup_api_url?: string | null;
}

/**
 * Полная проверка конфигурации стенда. Бросает GuardError с понятным текстом.
 * forbidden — список production-хостов (таблица forbidden_hosts).
 */
export function assertStandSafe(stand: GuardStand, forbidden: readonly string[] = []): void {
  if (!(STAND_ENVS as readonly string[]).includes(stand.env)) {
    throw new GuardError(`Окружение "${stand.env}" запрещено. Допустимы: ${STAND_ENVS.join(", ")}`);
  }
  if (!stand.allowed_hosts.length) {
    throw new GuardError(`У стенда ${stand.slug} пустой allowed_hosts`);
  }
  const urls = [stand.base_url, stand.health_url, stand.mailbox_api_url, stand.cleanup_api_url].filter(
    (u): u is string => !!u,
  );
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) throw new GuardError(`Невалидный URL: ${url}`);
    if (!/^https?:$/.test(new URL(url).protocol)) throw new GuardError(`Только http/https: ${url}`);
    if (!hostAllowed(host, stand.allowed_hosts)) {
      throw new GuardError(`Хост ${host} не входит в allowed_hosts стенда ${stand.slug}`);
    }
  }
  for (const allowed of stand.allowed_hosts) {
    const bad = forbidden.find((f) => patternsOverlap(allowed, f));
    if (bad) throw new GuardError(`Стенд ${stand.slug} ссылается на запрещённый (production) хост ${bad}`);
  }
}

/** Проверка одного запроса из браузера/воркера. */
export function isRequestAllowed(url: string, allowedHosts: readonly string[]): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return true;
  const host = hostOf(url);
  return !!host && hostAllowed(host, allowedHosts);
}

/**
 * Маркер окружения из ответа /health. Принимает JSON ({"env":"staging"} или {"environment":"staging"})
 * или plain text.
 */
export function extractEnvMarker(body: string): string | null {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const v = json.env ?? json.environment ?? json.stage;
    return typeof v === "string" ? v.toLowerCase() : null;
  } catch {
    return trimmed ? trimmed.toLowerCase().slice(0, 64) : null;
  }
}

export function assertEnvMarker(body: string, expected: string, env: StandEnv | string): void {
  const marker = extractEnvMarker(body);
  if (marker === "production" || marker === "prod") {
    throw new GuardError(`Стенд сообщает, что он production (${marker}). Прогон остановлен.`);
  }
  if (marker !== expected.toLowerCase()) {
    throw new GuardError(`Ожидался маркер окружения "${expected}" (${env}), стенд вернул "${marker ?? "пусто"}"`);
  }
}
