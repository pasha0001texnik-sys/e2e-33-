// Профили гео- и сетевой эмуляции прогона. Браузеробезопасно (только данные и
// типы) — используется в веб-форме, воркере и реестре результатов.
//
// Важно: это эмуляция на стороне браузера воркера (координаты геолокации,
// разрешение geolocation, троттлинг скорости/задержки, offline). Трафик НЕ
// маршрутизируется через внешние узлы/прокси — ограничение allowlist и сетевой
// guard остаются в силе. Каталог живёт в коде, в БД хранится только ключ.

/** Гео-эмуляция: координаты и подпись региона для отчёта. */
export interface GeoEmulation {
  latitude: number;
  longitude: number;
  /** Точность, м (по умолчанию 20) */
  accuracy?: number;
  /** Человеко-читаемая подпись — пишется в run_results.region */
  region?: string;
  /** Выдать разрешение geolocation для base_url стенда (по умолчанию true) */
  grant_geolocation?: boolean;
}

/**
 * Сетевые условия. Значения совпадают по смыслу с NetworkProfile (types.ts):
 * download/upload — байт/с (null — без ограничения), latency — доп. задержка в мс.
 * Применяются через CDP Network.emulateNetworkConditions (Chromium) и
 * context.setOffline — поверх перехвата запросов, не в обход guard.
 */
export interface NetworkConditions {
  offline?: boolean;
  download?: number | null;
  upload?: number | null;
  latency?: number | null;
}

export interface NetProfile {
  key: string;
  label: string;
  geo: GeoEmulation | null;
  network: NetworkConditions | null;
}

// Пресеты скоростей (байт/с). Ориентированы на привычные значения DevTools,
// значения намеренно круглые — это условия теста, а не замер реальной сети.
const SLOW_3G: NetworkConditions = { offline: false, download: 50_000, upload: 50_000, latency: 400 };
const FAST_3G: NetworkConditions = { offline: false, download: 180_000, upload: 84_000, latency: 150 };

/** Каталог профилей. Ключ хранится в runs.net_profile / test_flags.net_profile. */
export const NET_PROFILES: NetProfile[] = [
  { key: "none", label: "Без эмуляции (по умолчанию)", geo: null, network: null },
  { key: "offline", label: "Оффлайн (сеть недоступна)", geo: null, network: { offline: true } },
  { key: "slow-3g", label: "Медленный 3G", geo: null, network: SLOW_3G },
  { key: "fast-3g", label: "Быстрый 3G", geo: null, network: FAST_3G },
  {
    key: "geo-moscow",
    label: "Гео: Москва (RU)",
    geo: { latitude: 55.7558, longitude: 37.6173, accuracy: 20, region: "RU / Москва", grant_geolocation: true },
    network: null,
  },
  {
    key: "geo-berlin",
    label: "Гео: Берлин (DE)",
    geo: { latitude: 52.52, longitude: 13.405, accuracy: 20, region: "DE / Берлин", grant_geolocation: true },
    network: null,
  },
  {
    key: "geo-newyork",
    label: "Гео: Нью-Йорк (US)",
    geo: { latitude: 40.7128, longitude: -74.006, accuracy: 20, region: "US / Нью-Йорк", grant_geolocation: true },
    network: null,
  },
];

export const DEFAULT_NET_PROFILE = "none";

export function getNetProfile(key: string | null | undefined): NetProfile {
  return NET_PROFILES.find((p) => p.key === key) ?? NET_PROFILES.find((p) => p.key === DEFAULT_NET_PROFILE)!;
}

/**
 * Итоговый ключ профиля: выбор прогона переопределяет дефолт стенда
 * (test_flags.net_profile), иначе — профиль по умолчанию.
 */
export function resolveNetProfile(runKey: string | null | undefined, standKey: string | null | undefined): NetProfile {
  const key = runKey || standKey || DEFAULT_NET_PROFILE;
  return getNetProfile(key);
}

/** Применяет ли профиль какую-либо эмуляцию (иначе контекст создаётся как раньше). */
export function hasEmulation(p: NetProfile): boolean {
  if (p.geo) return true;
  const n = p.network;
  return !!n && (n.offline === true || n.download != null || n.upload != null || n.latency != null);
}
