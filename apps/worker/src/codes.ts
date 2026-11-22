// Универсальный адаптер получения проверочного кода из HTTP-источника тестового
// контура (перехватчик SMS/почты, вебхук-синк и т.п.) во время шага сценария.
//
// Ограничение проекта (как у Mailbox): запрос идёт ТОЛЬКО на хост из
// stand.allowed_hosts и не из forbidden_hosts, с redirect:"manual" и таймаутом.
// То есть источник кодов — сервис стенда, а не произвольный внешний OTP/SMS-API:
// инвариант egress-allowlist сохраняется. Конфиг живёт в stand.test_flags.code_provider.

import { DEFAULT_CODE_REGEX, GuardError, InfraError, requestHostStatus, type CodeExtract, type CodeProviderConfig, type Stand } from "@e2e/shared";

// Тип конфига и чистый валидатор живут в @e2e/shared (общий источник для веб-формы).
export type { CodeExtract, CodeProviderConfig } from "@e2e/shared";

export interface WaitCodeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  extract?: CodeExtract;
}

export interface CodeProvider {
  /** Ждёт и возвращает код по идентификатору сессии/запроса. */
  waitForCode(id: string, opts?: WaitCodeOptions): Promise<string>;
  /** Освобождает/отменяет запрос по идентификатору (best-effort). */
  release(id: string): Promise<void>;
  /** Освобождает все незакрытые запросы — вызывается раннером при очистке. */
  releaseOutstanding(): Promise<void>;
}

const DEFAULTS = { timeout_ms: 60000, poll_interval_ms: 2000, request_timeout_ms: 10000 };

export type FetchImpl = typeof fetch;

/** Код не получен за отведённое время. name=TimeoutError → classifyError даёт kind "timeout" (по умолчанию не ретраится). */
export class CodeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

class CodeCancelledError extends Error {
  constructor(message = "Ожидание кода прервано") {
    super(message);
    this.name = "CancelledError";
  }
}

export interface HttpCodeProviderDeps {
  stand: Stand;
  config: CodeProviderConfig;
  secrets: Record<string, string>;
  /** Запрещённые хосты (как у браузерного guard) */
  forbidden: readonly string[];
  /** Заголовки трассировки прогона */
  headers?: Record<string, string>;
  /** Сигнал отмены (отмена прогона / завершение попытки) */
  signal: AbortSignal;
  log?: (message: string) => void;
  /** Инъекция fetch для тестов */
  fetchImpl?: FetchImpl;
}

export class HttpCodeProvider implements CodeProvider {
  private readonly active = new Set<string>();
  private readonly token?: string;
  private readonly doFetch: FetchImpl;

  constructor(private readonly d: HttpCodeProviderDeps) {
    this.token = d.config.token_secret ? d.secrets[d.config.token_secret] : undefined;
    this.doFetch = d.fetchImpl ?? fetch;
  }

  private get safeUrl(): string {
    try {
      return new URL(this.d.config.url).origin;
    } catch {
      return "источник кодов";
    }
  }

  private assertAllowed(url: string): void {
    const status = requestHostStatus(url, this.d.stand.allowed_hosts, this.d.forbidden);
    if (status === "invalid") throw new GuardError(`Некорректный URL источника кодов: ${url}`);
    if (status === "forbidden") throw new GuardError(`Источник кодов на запрещённом хосте: ${url}`);
    if (status !== "ok") throw new GuardError(`Источник кодов вне allowlist стенда: ${url}`);
  }

  private authHeaders(json = false): Record<string, string> {
    return {
      ...(this.d.headers ?? {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  private async fetchOnce(id: string): Promise<{ status: number; bodyText: string; json: unknown }> {
    const cfg = this.d.config;
    const rawPath = render(cfg.path ?? "{id}", id);
    const url = new URL(rawPath, cfg.url).toString();
    this.assertAllowed(url);
    const method = cfg.method ?? "GET";
    const res = await this.doFetch(url, {
      method,
      headers: this.authHeaders(method === "POST"),
      body: method === "POST" ? JSON.stringify({ id }) : undefined,
      redirect: "manual", // редирект мог бы увести за пределы allowlist
      signal: AbortSignal.any([this.d.signal, AbortSignal.timeout(cfg.request_timeout_ms ?? DEFAULTS.request_timeout_ms)]),
    });
    const bodyText = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    return { status: res.status, bodyText, json };
  }

  async waitForCode(id: string, opts: WaitCodeOptions = {}): Promise<string> {
    const cfg = this.d.config;
    const timeout = opts.timeoutMs ?? cfg.timeout_ms ?? DEFAULTS.timeout_ms;
    const interval = opts.pollIntervalMs ?? cfg.poll_interval_ms ?? DEFAULTS.poll_interval_ms;
    const extract = opts.extract ?? cfg.extract ?? { regex: DEFAULT_CODE_REGEX };
    const deadline = Date.now() + timeout;
    const started = Date.now();
    let sawResponse = false;
    let lastErr = "";

    this.active.add(id);
    try {
      for (;;) {
        if (this.d.signal.aborted) throw new CodeCancelledError();
        try {
          const { status, bodyText, json } = await this.fetchOnce(id);
          if (status === 401 || status === 403) {
            throw new InfraError(`Источник кодов вернул ${status} (авторизация/конфигурация): ${this.safeUrl}`);
          }
          if (status >= 200 && status < 300) {
            sawResponse = true;
            const code = extractCode(bodyText, json, extract);
            if (code) {
              this.d.log?.(`Код получен от источника за ${Date.now() - started} мс`);
              return code;
            }
          } else if (status >= 500) {
            lastErr = `HTTP ${status}`;
          } else {
            // 404/409/425 и прочее — ресурс/код ещё не готов, продолжаем опрос
            sawResponse = true;
          }
        } catch (e) {
          const err = e as Error;
          // Фатальные: guard, явная отмена, ошибка авторизации/конфигурации
          if (err.name === "GuardError" || err.name === "CancelledError" || err instanceof InfraError) throw e;
          // Сетевая ошибка/таймаут одного опроса — терпим до дедлайна
          lastErr = err.message;
        }
        if (Date.now() + interval >= deadline) break;
        await delay(interval, this.d.signal);
      }
    } finally {
      this.active.delete(id);
    }

    if (!sawResponse) throw new InfraError(`Источник кодов недоступен за ${timeout} мс (${this.safeUrl})${lastErr ? `: ${lastErr}` : ""}`);
    throw new CodeTimeoutError(`Код по «${id}» не получен за ${timeout} мс (${this.safeUrl})`);
  }

  async release(id: string): Promise<void> {
    const cfg = this.d.config;
    if (!cfg.release_path) {
      this.active.delete(id);
      return;
    }
    try {
      const url = new URL(render(cfg.release_path, id), cfg.url).toString();
      this.assertAllowed(url);
      // release не привязан к signal попытки: должен отработать и во время очистки после отмены
      await this.doFetch(url, {
        method: cfg.release_method ?? "DELETE",
        headers: this.authHeaders(),
        redirect: "manual",
        signal: AbortSignal.timeout(cfg.request_timeout_ms ?? DEFAULTS.request_timeout_ms),
      });
    } catch (e) {
      this.d.log?.(`Освобождение запроса кода не удалось (${this.safeUrl}): ${(e as Error).message}`);
    } finally {
      this.active.delete(id);
    }
  }

  async releaseOutstanding(): Promise<void> {
    for (const id of [...this.active]) await this.release(id);
    this.active.clear();
  }
}

/** Провайдер-заглушка: используется, если code_provider не настроен на стенде. */
class UnconfiguredCodeProvider implements CodeProvider {
  async waitForCode(): Promise<string> {
    throw new Error("Источник кодов не настроен: добавьте code_provider в test_flags стенда");
  }
  async release(): Promise<void> {}
  async releaseOutstanding(): Promise<void> {}
}

export function createCodeProvider(opts: Omit<HttpCodeProviderDeps, "config"> & { config?: CodeProviderConfig }): CodeProvider {
  const cfg = opts.config ?? (opts.stand.test_flags as { code_provider?: CodeProviderConfig }).code_provider;
  if (!cfg || !cfg.url) return new UnconfiguredCodeProvider();
  return new HttpCodeProvider({ ...opts, config: cfg });
}

/** Подстановка {id} в шаблон пути (URL-экранированная). */
function render(template: string, id: string): string {
  return template.replace(/\{id\}/g, encodeURIComponent(id));
}

/** Значение по dot-пути в JSON-объекте. */
function pickField(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

/** Извлечение кода: точное поле JSON и/или регэксп. Возвращает null, если кода ещё нет. */
export function extractCode(bodyText: string, json: unknown, extract: CodeExtract): string | null {
  let source = bodyText;
  if (extract.field) {
    const v = json !== undefined ? pickField(json, extract.field) : undefined;
    if (v == null) return null;
    source = String(v);
    if (!extract.regex) return source.trim() || null;
  }
  const re = new RegExp(extract.regex ?? DEFAULT_CODE_REGEX);
  const m = source.match(re);
  if (!m) return null;
  return m[1] ?? m[0];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
