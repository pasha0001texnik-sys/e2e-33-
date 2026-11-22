import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CancelledError,
  classifyError,
  finalRunStatus,
  GuardError,
  isRetryable,
  summarize,
  type ErrorKind,
  type HoldAction,
  type NetworkError,
  type Run,
  type RunTest,
  type Stand,
  type Suite,
  type TestStatus,
} from "@e2e/shared";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Artifacts } from "./artifacts.ts";
import type { Config } from "./config.ts";
import { must, type Db } from "./db.ts";
import { FixtureService } from "./fixtures.ts";
import { RunLogger } from "./logger.ts";
import { Mailbox } from "./mail.ts";
import { installNetworkGuards, preflight, type GuardState } from "./preflight.ts";
import { getScenario } from "./scenarios/index.ts";
import type { ScenarioContext, StandFlags, StepOptions } from "./scenarios/types.ts";

export interface RunnerDeps {
  db: Db;
  cfg: Config;
  artifacts: Artifacts;
}

class HoldFailedError extends Error {
  constructor(step: string) {
    super(`Шаг "${step}" отмечен инженером как failed (manual_hold)`);
    this.name = "HoldFailedError";
  }
}

class TestTimeoutError extends Error {
  constructor(sec: number) {
    super(`Тест превысил таймаут ${sec} с`);
    this.name = "TimeoutError";
  }
}

/** Флаги отмены/паузы, которые воркер получает из БД вместе с heartbeat. */
class RunControl {
  cancelled = false;
  paused = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private db: Db,
    private run: Run,
    private log: RunLogger,
    private intervalMs: number,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async tick() {
    const { data } = await this.db
      .from("runs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", this.run.id)
      .select("cancel_requested, pause_requested, status")
      .single();
    if (!data) return;
    if (data.cancel_requested && !this.cancelled) {
      this.cancelled = true;
      this.log.write("warn", "Получен запрос на отмену: новые тесты не запускаются, идущие прерываются");
    }
    if (data.pause_requested !== this.paused) {
      this.paused = data.pause_requested;
      this.log.write("info", this.paused ? "Прогон на паузе: новые тесты не выдаются" : "Пауза снята");
      await this.db.from("runs").update({ status: this.paused ? "paused" : "running" }).eq("id", this.run.id);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

export async function executeRun(run: Run, deps: RunnerDeps): Promise<void> {
  const { db, cfg } = deps;
  const log = new RunLogger(db, run.id, run.trace_id);
  const control = new RunControl(db, run, log, cfg.HEARTBEAT_INTERVAL_MS);
  control.start();
  let browser: Browser | undefined;

  try {
    const stand = must(await db.from("stands").select("*").eq("id", run.stand_id).single(), "stand") as Stand;
    const suite = must(await db.from("suites").select("*").eq("id", run.suite_id).single(), "suite") as Suite;
    const forbidden = (must(await db.from("forbidden_hosts").select("pattern"), "forbidden_hosts") as { pattern: string }[]).map(
      (f) => f.pattern,
    );
    const secretRows = (must(await db.rpc("worker_get_stand_secrets", { p_stand: stand.id }), "secrets") ?? []) as {
      name: string;
      value: string;
    }[];
    const secrets = Object.fromEntries(secretRows.map((s) => [s.name, s.value]));
    log.addSecret(...Object.values(secrets));

    log.write("info", `Прогон #${run.number}: сюит «${suite.name}» на стенде ${stand.slug}, сборка ${run.build_tag}`, {
      parallelism: run.parallelism,
      worker: cfg.WORKER_ID,
    });

    // Тесты прогона
    const keys = run.only_scenarios?.length ? run.only_scenarios : suite.scenario_keys;
    const rows = keys.map((key) => ({
      run_id: run.id,
      scenario_key: key,
      name: getScenario(key)?.name ?? key,
      max_attempts: run.max_retries + 1,
      status: getScenario(key) ? ("queued" as const) : ("skipped" as const),
      error: getScenario(key) ? null : "Сценарий не найден в реестре воркера",
    }));
    const tests = must(
      await db.from("run_tests").upsert(rows, { onConflict: "run_id,scenario_key" }).select("*"),
      "run_tests",
    ) as RunTest[];

    // Проверки безопасности до запуска браузера
    try {
      const pf = await preflight(stand, run, forbidden, cfg.HEALTH_TIMEOUT_MS);
      for (const w of pf.warnings) log.write("warn", w);
      if (pf.deployedBuild) log.write("info", `Стенд сообщает сборку ${pf.deployedBuild}`);
    } catch (e) {
      const kind = classifyError(e);
      log.write("error", `Предстартовая проверка не пройдена: ${(e as Error).message}`, { kind });
      await db
        .from("run_tests")
        .update({ status: "skipped", error: "Прогон не стартовал: предстартовая проверка" })
        .eq("run_id", run.id)
        .eq("status", "queued");
      await finishRun(db, run, "error", (e as Error).message);
      return;
    }

    browser = await chromium.launch({ headless: cfg.HEADLESS, executablePath: cfg.BROWSER_EXECUTABLE_PATH });
    const queue = tests.filter((t) => t.status === "queued");
    const flags = stand.test_flags as StandFlags;
    const mailbox = new Mailbox(stand, secrets.mailbox_token);

    const workers = Array.from({ length: Math.max(1, run.parallelism) }, async () => {
      for (;;) {
        while (control.paused && !control.cancelled) await sleep(1000);
        const test = queue.shift();
        if (!test) return;
        if (control.cancelled) {
          await db.from("run_tests").update({ status: "cancelled", finished_at: now() }).eq("id", test.id);
          continue;
        }
        await executeTest({ run, stand, suite, test, browser: browser!, secrets, flags, mailbox, control, log, deps });
      }
    });
    await Promise.all(workers);

    // Фикстуры прогона: по умолчанию — в очередь на очистку
    if (!flags.keep_fixtures) {
      await db
        .from("fixtures")
        .update({ status: "cleanup_pending", locked_by: null })
        .eq("run_id", run.id)
        .in("status", ["created", "verified", "in_use", "failed"]);
    } else {
      await db.from("fixtures").update({ locked_by: null }).eq("run_id", run.id);
      await db.from("fixtures").update({ status: "cleanup_pending" }).eq("run_id", run.id).in("status", ["created", "in_use"]);
    }

    const final = (must(await db.from("run_tests").select("status, duration_ms").eq("run_id", run.id), "summary") ??
      []) as { status: TestStatus; duration_ms: number | null }[];
    const summary = summarize(final);
    const status = finalRunStatus(summary, control.cancelled);
    log.write(status === "passed" ? "info" : "warn", `Прогон завершён: ${status}`, summary as Record<string, unknown>);
    await finishRun(db, run, status, null, summary as Record<string, unknown>);
  } catch (e) {
    log.write("error", `Сбой воркера: ${(e as Error).message}`);
    await finishRun(db, run, "error", (e as Error).message);
  } finally {
    control.stop();
    await browser?.close().catch(() => {});
    await log.close();
  }
}

async function finishRun(db: Db, run: Run, status: string, error: string | null, summary?: Record<string, unknown>) {
  await db
    .from("runs")
    .update({ status, error, finished_at: now(), ...(summary ? { summary } : {}) })
    .eq("id", run.id);
}

interface TestArgs {
  run: Run;
  stand: Stand;
  suite: Suite;
  test: RunTest;
  browser: Browser;
  secrets: Record<string, string>;
  flags: StandFlags;
  mailbox: Mailbox;
  control: RunControl;
  log: RunLogger;
  deps: RunnerDeps;
}

async function executeTest(a: TestArgs) {
  const { run, stand, suite, test, browser, control, log, deps } = a;
  const { db, cfg, artifacts } = deps;
  const scenario = getScenario(test.scenario_key)!;
  const tlog = log.for(test.id);
  const started = Date.now();
  let finalStatus: TestStatus = "failed";
  let lastError: string | null = null;
  let lastKind: ErrorKind | null = null;
  let tracePath: string | null = null;
  const claimed: string[] = [];

  for (let attempt = 1; attempt <= test.max_attempts; attempt++) {
    if (control.cancelled) {
      finalStatus = "cancelled";
      break;
    }
    await db
      .from("run_tests")
      .update({ status: "running", attempt, started_at: attempt === 1 ? now() : undefined, error: null, error_kind: null })
      .eq("id", test.id);
    tlog.info(`▶ ${scenario.name} (попытка ${attempt}/${test.max_attempts})`);

    // Чистый контекст на каждую попытку: без кэша, cookies и storage
    const context = await browser.newContext({
      baseURL: stand.base_url,
      locale: "ru-RU",
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: a.flags.ignore_https_errors === true,
      serviceWorkers: "block", // иначе запросы SW обходят сетевой guard
    });
    const guard = await installNetworkGuards(context, stand, (host) =>
      tlog.warn(`Заблокирован запрос к хосту вне allowlist: ${host}`),
    );
    const tracing = cfg.TRACE_MODE !== "off";
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();

    const holdState = { holding: false };
    const fixtures = new FixtureService(db, stand, run, test.id, log, claimed);
    const stepper = new Stepper({ ...a, page, attempt, holdState, guard });
    const ctx: ScenarioContext = {
      page,
      context,
      stand,
      run,
      test,
      attempt,
      secrets: a.secrets,
      flags: a.flags,
      fixtures,
      mail: a.mailbox,
      step: (name, fn, opts) => stepper.step(name, fn, opts),
      log: (m, d) => tlog.info(m, d),
    };

    let ok = false;
    try {
      await withTestTimeout(scenario.run(ctx), suite.test_timeout_sec, holdState, control);
      assertNoViolations(guard);
      ok = true;
    } catch (e) {
      lastKind = e instanceof HoldFailedError ? "assertion" : classifyError(e);
      lastError = log.redact((e as Error).message ?? String(e)).slice(0, 4000);
      tlog.error(`✗ ${lastError}`, { kind: lastKind, attempt });
    }

    // Трейс сохраняем при падении/flaky (или всегда в режиме "on")
    const keepTrace = tracing && (cfg.TRACE_MODE === "on" || !ok || attempt > 1);
    if (tracing) {
      if (keepTrace) {
        const dir = await mkdtemp(join(tmpdir(), "trace-"));
        const file = join(dir, "trace.zip");
        await context.tracing.stop({ path: file }).catch(() => {});
        const buf = await readFile(file).catch(() => null);
        if (buf) tracePath = await artifacts.upload(Artifacts.path(run.id, test.id, attempt, "trace.zip"), buf, "application/zip");
        await rm(dir, { recursive: true, force: true });
      } else {
        await context.tracing.stop().catch(() => {});
      }
    }
    await context.close().catch(() => {});

    if (ok) {
      finalStatus = attempt > 1 ? "flaky" : "passed";
      lastError = null;
      lastKind = null;
      break;
    }
    if (lastKind === "cancelled") {
      finalStatus = "cancelled";
      break;
    }
    if (isRetryable(lastKind!) && attempt < test.max_attempts) {
      tlog.warn(`Инфраструктурный сбой, повтор теста целиком со свежими фикстурами (${attempt + 1}/${test.max_attempts})`);
      await sleep(2000 * attempt);
      continue;
    }
    finalStatus = "failed";
    break;
  }

  if (finalStatus === "flaky") tlog.warn("Тест прошёл не с первой попытки — помечен как flaky");
  if (finalStatus === "passed" || finalStatus === "flaky") tlog.info(`✓ ${scenario.name}`);

  await db
    .from("run_tests")
    .update({
      status: finalStatus,
      flaky: finalStatus === "flaky",
      error: lastError,
      error_kind: lastKind,
      duration_ms: Date.now() - started,
      trace_path: tracePath,
      finished_at: now(),
      hold_requested: false,
    })
    .eq("id", test.id);

  // Взятые из реестра фикстуры: после успешного теста возвращаем в пул, иначе — на очистку
  const ok = finalStatus === "passed" || finalStatus === "flaky";
  if (claimed.length) {
    await db
      .from("fixtures")
      .update({ status: ok ? "verified" : "cleanup_pending", locked_by: null })
      .in("id", claimed)
      .eq("status", "in_use");
  }
  await db.from("fixtures").update({ locked_by: null }).eq("locked_by", test.id);

  // Промежуточная сводка — список прогонов показывает прогресс, не дожидаясь конца
  const { data: all } = await db.from("run_tests").select("status, duration_ms").eq("run_id", run.id);
  if (all) await db.from("runs").update({ summary: summarize(all as { status: TestStatus; duration_ms: number | null }[]) }).eq("id", run.id);
}

/** Шаги сценария: запись в run_steps, артефакты при падении, manual_hold. */
class Stepper {
  private idx = 0;
  private netErrors: NetworkError[] = [];

  constructor(
    private a: TestArgs & { page: Page; attempt: number; holdState: { holding: boolean }; guard: GuardState },
  ) {
    const { page, log } = a;
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "failed";
      if (failure.includes("ERR_BLOCKED_BY_CLIENT")) return;
      this.netErrors.push({ url: log.redact(req.url()).slice(0, 500), method: req.method(), failure });
    });
    page.on("response", (res) => {
      if (res.status() >= 500) {
        this.netErrors.push({ url: log.redact(res.url()).slice(0, 500), method: res.request().method(), status: res.status() });
      }
    });
  }

  async step<T>(name: string, fn: () => Promise<T>, opts: StepOptions = {}): Promise<T> {
    const { run, test, deps, control, log, attempt } = this.a;
    const { db } = deps;
    const tlog = log.for(test.id);
    if (control.cancelled) throw new CancelledError();

    // Hold, запрошенный из UI на «следующем шаге»
    const { data: fresh } = await db.from("run_tests").select("hold_requested").eq("id", test.id).single();
    if (fresh?.hold_requested) {
      const action = await this.hold(`${name} (перед шагом)`);
      if (action === "fail") throw new HoldFailedError(name);
      if (action === "abort") throw new CancelledError("Тест прерван инженером");
    }

    const idx = ++this.idx;
    this.netErrors = [];
    const row = must(
      await db
        .from("run_steps")
        .insert({ run_id: run.id, run_test_id: test.id, attempt, idx, name, status: "running" })
        .select("id")
        .single(),
      "run_steps insert",
    ) as { id: number };
    tlog.info(`  → ${name}`);

    const exec = () => (opts.timeoutMs ? withTimeout(fn(), opts.timeoutMs, `Шаг "${name}" превысил ${opts.timeoutMs} мс`) : fn());

    try {
      const result = await exec();
      assertNoViolations(this.a.guard);
      await db.from("run_steps").update({ status: "passed", finished_at: now(), network_errors: this.netErrors }).eq("id", row.id);
      return result;
    } catch (err) {
      let error = err as Error;
      const kind = classifyError(error);
      const shots = await this.capture(`step-${idx}`);

      // manual_hold при падении: сессия удерживается, инженер решает, что делать
      if (run.hold_on_failure && kind !== "cancelled" && kind !== "guard") {
        await db
          .from("run_steps")
          .update({ error: log.redact(error.message).slice(0, 4000), ...shots, network_errors: this.netErrors })
          .eq("id", row.id);
        const action = await this.hold(`${name} (после ошибки)`);
        if (action === "continue") {
          tlog.info(`  ↻ Повтор шага «${name}» после ручного разбора`);
          try {
            const result = await exec();
            await db.from("run_steps").update({ status: "passed", finished_at: now(), error: null }).eq("id", row.id);
            return result;
          } catch (err2) {
            error = err2 as Error;
          }
        } else if (action === "abort") {
          await db.from("run_steps").update({ status: "failed", finished_at: now() }).eq("id", row.id);
          throw new CancelledError("Тест прерван инженером");
        }
      }

      await db
        .from("run_steps")
        .update({
          status: "failed",
          finished_at: now(),
          error: log.redact(error.message ?? String(error)).slice(0, 4000),
          network_errors: this.netErrors,
          ...shots,
        })
        .eq("id", row.id);
      throw error;
    }
  }

  /** Скриншот (поля паролей замаскированы) и DOM (известные секреты вырезаны). */
  private async capture(name: string): Promise<{ screenshot_path?: string; dom_path?: string }> {
    const { page, run, test, attempt, log, deps } = this.a;
    const out: { screenshot_path?: string; dom_path?: string } = {};
    try {
      const png = await page.screenshot({ fullPage: true, mask: [page.locator('input[type="password"]')], timeout: 10000 });
      const p = await deps.artifacts.upload(Artifacts.path(run.id, test.id, attempt, `${name}.png`), png, "image/png");
      if (p) out.screenshot_path = p;
    } catch {
      /* страница могла закрыться */
    }
    try {
      const html = log.redact(await page.content());
      const p = await deps.artifacts.upload(Artifacts.path(run.id, test.id, attempt, `${name}.html`), html, "text/html");
      if (p) out.dom_path = p;
    } catch {
      /* ignore */
    }
    return out;
  }

  private async hold(stepName: string): Promise<HoldAction> {
    const { run, stand, test, control, log, deps } = this.a;
    const { db, cfg } = deps;
    const tlog = log.for(test.id);

    // лимит одновременных hold на стенде: удержание занимает слот воркера и стенда
    const { data: running } = await db.from("runs").select("id").eq("stand_id", stand.id).in("status", ["running", "paused"]);
    const ids = (running ?? []).map((r: { id: string }) => r.id);
    const { count } = await db.from("run_tests").select("id", { count: "exact", head: true }).eq("status", "on_hold").in("run_id", ids);
    if ((count ?? 0) >= stand.max_holds) {
      tlog.warn(`manual_hold пропущен: на стенде уже ${count} удержаний (лимит ${stand.max_holds})`);
      await db.from("run_tests").update({ hold_requested: false }).eq("id", test.id);
      return stepName.includes("после ошибки") ? "fail" : "continue";
    }

    const until = new Date(Date.now() + cfg.HOLD_TIMEOUT_SEC * 1000);
    const shot = await this.capture("hold");
    await db
      .from("run_tests")
      .update({ status: "on_hold", hold_step: stepName, hold_until: until.toISOString(), hold_action: null, hold_requested: false })
      .eq("id", test.id);
    if (shot.screenshot_path) tlog.info("Снимок экрана на момент удержания сохранён", { screenshot_path: shot.screenshot_path });
    tlog.warn(`⏸ manual_hold на шаге «${stepName}» до ${until.toLocaleTimeString("ru-RU")}: ждём continue / fail / abort`);
    tlog.warn("Коды и сессии на стенде могут истечь за время удержания — это не дефект продукта");

    this.a.holdState.holding = true;
    let action: HoldAction = "abort";
    try {
      while (Date.now() < until.getTime()) {
        if (control.cancelled) break;
        const { data } = await db.from("run_tests").select("hold_action").eq("id", test.id).single();
        if (data?.hold_action) {
          action = data.hold_action as HoldAction;
          break;
        }
        await sleep(2000);
      }
      if (Date.now() >= until.getTime()) tlog.warn("Таймаут manual_hold: тест прерван");
    } finally {
      this.a.holdState.holding = false;
    }
    tlog.info(`manual_hold: ${action}`);
    await db.from("run_tests").update({ status: "running", hold_until: null, hold_action: null }).eq("id", test.id);
    return action;
  }
}

/** Ответ с хоста вне allowlist — немедленный провал теста с типом guard. */
function assertNoViolations(guard: GuardState) {
  if (guard.violations.length) {
    throw new GuardError(`Запрос ушёл на хост вне allowlist: ${guard.violations[0]}. Тест остановлен.`);
  }
}

/** Таймаут теста, который не тикает, пока тест удерживается (manual_hold). */
function withTestTimeout<T>(p: Promise<T>, sec: number, hold: { holding: boolean }, control: RunControl): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let elapsed = 0;
    const iv = setInterval(() => {
      if (control.cancelled) {
        clearInterval(iv);
        reject(new CancelledError());
        return;
      }
      if (!hold.holding) elapsed += 1;
      if (elapsed > sec) {
        clearInterval(iv);
        reject(new TestTimeoutError(sec));
      }
    }, 1000);
    p.then(
      (v) => {
        clearInterval(iv);
        resolve(v);
      },
      (e) => {
        clearInterval(iv);
        reject(e);
      },
    );
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error(message);
      e.name = "TimeoutError";
      reject(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

