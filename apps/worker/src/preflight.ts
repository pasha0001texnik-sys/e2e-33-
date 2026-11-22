import {
  assertEnvMarker,
  assertStandSafe,
  GuardError,
  InfraError,
  isRequestAllowed,
  type Run,
  type Stand,
} from "@e2e/shared";
import type { BrowserContext } from "@playwright/test";

export interface PreflightResult {
  deployedBuild: string | null;
  warnings: string[];
}

/**
 * Проверки перед стартом прогона:
 * 1) конфигурация стенда безопасна (allowlist, запрещённые хосты, env);
 * 2) /health стенда отвечает и сообщает ожидаемое окружение (не production);
 * 3) стенд развернул именно ту сборку, для которой запущен прогон (если отдаёт версию).
 */
export async function preflight(
  stand: Stand,
  run: Run,
  forbidden: string[],
  timeoutMs: number,
): Promise<PreflightResult> {
  assertStandSafe(stand, forbidden);
  const warnings: string[] = [];
  if (!stand.health_url) {
    if (stand.expected_env_marker) throw new GuardError("Задан expected_env_marker, но нет health_url");
    warnings.push("У стенда не задан health_url: маркер окружения и версия сборки не проверяются");
    return { deployedBuild: null, warnings };
  }

  let body: string;
  try {
    const res = await fetch(stand.health_url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = new URL(res.headers.get("location") ?? "", stand.health_url).toString();
      if (!isRequestAllowed(loc, stand.allowed_hosts)) {
        throw new GuardError(`health_url перенаправляет на хост вне allowlist: ${loc}`);
      }
      throw new InfraError(`health_url отвечает редиректом на ${loc} — укажите в стенде конечный адрес`);
    }
    if (!res.ok) throw new InfraError(`Стенд недоступен: ${stand.health_url} ответил ${res.status}`);
    body = await res.text();
  } catch (e) {
    if (e instanceof GuardError || e instanceof InfraError) throw e;
    throw new InfraError(`Стенд недоступен: ${(e as Error).message}`);
  }

  if (stand.expected_env_marker) assertEnvMarker(body, stand.expected_env_marker, stand.env);

  let deployedBuild: string | null = null;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const v = json.build_tag ?? json.build ?? json.version;
    deployedBuild = typeof v === "string" ? v : null;
  } catch {
    /* plain text health */
  }
  if (deployedBuild && run.build_tag !== "latest" && deployedBuild !== run.build_tag) {
    throw new GuardError(`Стенд развернул сборку ${deployedBuild}, а прогон запущен для ${run.build_tag}`);
  }
  if (!deployedBuild && run.build_tag !== "latest") {
    warnings.push("health стенда не отдаёт версию: соответствие build_tag не проверено");
  }
  return { deployedBuild, warnings };
}

interface MockRoute {
  url: string; // glob Playwright, например "**/api/sms/send"
  method?: string;
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
}

export interface GuardState {
  /** Запросы на хосты вне allowlist, которые всё же ушли (не должно случаться). */
  violations: string[];
}

/**
 * Потоковые запросы не буферизуем (SSE и медиа сломались бы) — их редиректы
 * ловит страховка по событию response, которая валит тест.
 */
const STREAMING = new Set(["eventsource", "websocket", "media"]);

/**
 * Сетевой guard в браузере: всё, что не в allowlist стенда, блокируется.
 * Редиректы не проходят через page.route, поэтому запрос выполняется вручную
 * без следования редиректам, а заголовок Location проверяется по allowlist.
 * Плюс моки из stand.mocks.routes и ограничение RPS.
 */
export async function installNetworkGuards(
  context: BrowserContext,
  stand: Pick<Stand, "allowed_hosts" | "rps_limit" | "mocks">,
  onBlocked: (url: string) => void,
): Promise<GuardState> {
  const state: GuardState = { violations: [] };
  const blockedHosts = new Set<string>();
  const rps = stand.rps_limit ?? 0;
  let windowStart = Date.now();
  let inWindow = 0;

  const block = (url: string) => {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    if (!blockedHosts.has(host)) {
      blockedHosts.add(host);
      onBlocked(host);
    }
  };

  // Последняя линия: пришёл ответ с чужого хоста — значит, запрос всё-таки ушёл
  context.on("response", (res) => {
    if (!isRequestAllowed(res.url(), stand.allowed_hosts)) state.violations.push(res.url());
  });

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (!isRequestAllowed(url, stand.allowed_hosts)) {
      block(url);
      return route.abort("blockedbyclient");
    }
    if (rps > 0) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > rps) {
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - windowStart))));
      }
    }
    if (STREAMING.has(req.resourceType()) || /^(data|blob|about):/.test(url)) return route.fallback();

    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch {
      return route.abort("failed");
    }
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      if (location) {
        const target = new URL(location, url).toString();
        if (!isRequestAllowed(target, stand.allowed_hosts)) {
          block(target);
          return route.abort("blockedbyclient");
        }
      }
    }
    return route.fulfill({ response });
  });

  const routes = (stand.mocks as { routes?: MockRoute[] }).routes ?? [];
  for (const m of routes) {
    await context.route(m.url, (route) => {
      if (m.method && route.request().method() !== m.method.toUpperCase()) return route.fallback();
      return route.fulfill({
        status: m.status ?? 200,
        headers: m.headers,
        contentType: m.json !== undefined ? "application/json" : undefined,
        body: m.json !== undefined ? JSON.stringify(m.json) : (m.body ?? ""),
      });
    });
  }
  return state;
}
