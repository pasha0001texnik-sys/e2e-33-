import {
  CancelledError,
  classifyError,
  finalRunStatus,
  isRetryable,
  maskSecrets,
  summarize,
  traceHeaders,
  withDependencies,
  type ErrorKind,
  type HoldAction,
  type Run,
  type RunTest,
  type Stand,
  type Suite,
  type TestStatus,
} from "@e2e/shared";
import { chromium, type Browser } from "@playwright/test";
import { Artifacts } from "./artifacts.ts";
import type { Config } from "./config.ts";
import { must, type Db } from "./db.ts";
import { FixtureService } from "./fixtures.ts";
import { RunLogger } from "./logger.ts";
import { Mailbox } from "./mail.ts";
import { preflight } from "./preflight.ts";
import { recordResult } from "./results.ts";
import { DependencyQueue } from "./queue.ts";
import { getScenario } from "./scenarios/index.ts";
import {
  supportsPlatform,
  type BaseContext,
  type MobileScenarioContext,
  type ScenarioContext,
  type StandFlags,
  type StepOptions,
} from "./scenarios/types.ts";
import { openMobileSession, openWebSession, type TestSession } from "./session.ts";

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

const PASSED: TestStatus[] = ["passed", "flaky"];

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

/** Данные, которые тесты передают зависимым (ключ сценария → значения). */
type SharedOutputs = Map<string, Record<string, string | number | boolean | null>>;

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

    log.write(
      "info",
      `Прогон #${run.number}: сюит «${suite.name}» на стенде ${stand.slug} (${stand.platform}), сборка ${run.build_tag}`,
      { parallelism: run.parallelism, worker: cfg.WORKER_ID },
    );

    // Тесты прогона вместе с зависимостями (перезапуск упавших подтягивает и их «поставщиков»)
    const requested = run.only_scenarios?.length ? run.only_scenarios : suite.scenario_keys;
    let keys: string[];
    try {
      keys = withDependencies(requested, (k) => {
        const s = getScenario(k);
        return s ? { dependsOn: s.dependsOn ?? [] } : undefined;
      });
    } catch (e) {
      log.write("error", (e as Error).message);
      await finishRun(db, run, "error", (e as Error).message);
      return;
    }
    const added = keys.filter((k) => !requested.includes(k));
    if (added.length) log.write("info", `Добавлены зависимости: ${added.join(", ")}`);

    const rows = keys.map((key) => {
      const s = getScenario(key);
      const reason = !s
        ? "Сценарий не найден в реестре воркера"
        : !supportsPlatform(s, stand.platform)
          ? `У сценария нет реализации для платформы ${stand.platform}`
          : null;
      return {
        run_id: run.id,
        scenario_key: key,
        name: s?.name ?? key,
        max_attempts: run.max_retries + 1,
        depends_on: s?.dependsOn ?? [],
        status: reason ? ("skipped" as const) : ("queued" as const),
        error: reason,
      };
    });
    const tests = must(
      await db.from("run_tests").upsert(rows, { onConflict: "run_id,scenario_key" }).select("*"),
      "run_tests",
    ) as RunTest[];
    tests.sort((a, b) => keys.indexOf(a.scenario_key) - keys.indexOf(b.scenario_key));

    // Проверки безопасности до запуска браузера/эмулятора
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

    if (stand.platform === "web") {
      browser = await chromium.launch({ headless: cfg.HEADLESS, executablePath: cfg.BROWSER_EXECUTABLE_PATH });
    }
    const flags = stand.test_flags as StandFlags;
    const mailbox = new Mailbox(stand, secrets.mailbox_token, traceHeaders({ traceId: run.trace_id, runId: run.id }));
    const outputs: SharedOutputs = new Map();

    // Очерёдность: тест стартует, когда все его зависимости прошли
    const queue = new DependencyQueue(
      tests.filter((t) => t.status === "queued"),
      tests.filter((t) => t.status !== "queued").map((t) => [t.scenario_key, t.status] as [string, TestStatus]),
    );
    let running = 0;

    const pool = Array.from({ length: Math.max(1, run.parallelism) }, async () => {
      for (;;) {
        while (control.paused && !control.cancelled) await sleep(1000);
        const next = queue.next(running, control.cancelled);
        if (next.kind === "done") return;
        if (next.kind === "wait") {
          await sleep(300);
          continue;
        }
        const test = next.item;
        if (next.kind === "skip") {
          await db.from("run_tests").update({ status: "skipped", error: next.reason, finished_at: now() }).eq("id", test.id);
          log.for(test.id).warn(next.reason);
          continue;
        }
        if (control.cancelled) {
          queue.complete(test.scenario_key, "cancelled");
          await db.from("run_tests").update({ status: "cancelled", finished_at: now() }).eq("id", test.id);
          continue;
        }
        running++;
        try {
          const status = await executeTest({ run, stand, suite, test, browser, secrets, flags, mailbox, control, log, deps, outputs });
          queue.complete(test.scenario_key, status);
        } catch (e) {
          queue.complete(test.scenario_key, "failed");
          throw e;
        } finally {
          running--;
        }
      }
    });
    await Promise.all(pool);

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
  browser?: Browser;
  secrets: Record<string, string>;
  flags: StandFlags;
  mailbox: Mailbox;
  control: RunControl;
  log: RunLogger;
  deps: RunnerDeps;
  outputs: SharedOutputs;
}

async function executeTest(a: TestArgs): Promise<TestStatus> {
  const { run, stand, suite, test, control, log, deps, outputs } = a;
  const { db, cfg, artifacts } = deps;
  const scenario = getScenario(test.scenario_key)!;
  const tlog = log.for(test.id);
  const started = Date.now();
  let finalStatus: TestStatus = "failed";
  let lastError: string | null = null;
  let lastKind: ErrorKind | null = null;
  let tracePath: string | null = null;
  let storageDump: Record<string, unknown> | null = null;
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
    outputs.delete(test.scenario_key); // каждая попытка передаёт данные заново

    let session: TestSession | undefined;
    let ok = false;
    const holdState = { holding: false };
    try {
      session =
        stand.platform === "web"
          ? await openWebSession({ browser: a.browser!, stand, run, test, flags: a.flags, cfg, log })
          : await openMobileSession({ stand, test, log });

      const fixtures = new FixtureService(db, stand, run, test.id, log, claimed);
      const stepper = new Stepper({ ...a, session, attempt, holdState });
      const base: BaseContext = {
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
        share: (key, value) => {
          if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
            throw new Error(`share("${key}"): можно передавать только строки, числа и boolean`);
          }
          outputs.set(test.scenario_key, { ...(outputs.get(test.scenario_key) ?? {}), [key]: value });
        },
        fromDependency: <T,>(dep: string, key: string) => {
          if (!test.depends_on.includes(dep)) {
            throw new Error(`Сценарий ${test.scenario_key} читает данные «${dep}», но не объявил его в dependsOn`);
          }
          return outputs.get(dep)?.[key] as T | undefined;
        },
      };

      const body =
        session.kind === "web"
          ? scenario.run!({ ...base, page: session.web!.page, context: session.web!.context } as ScenarioContext)
          : scenario.runMobile!({ ...base, driver: session.mobile!.driver, platform: session.mobile!.platform } as MobileScenarioContext);
      await withTestTimeout(body, suite.test_timeout_sec, holdState, control);
      session.assertSafe();
      ok = true;
    } catch (e) {
      lastKind = e instanceof HoldFailedError ? "assertion" : classifyError(e);
      lastError = log.redact((e as Error).message ?? String(e)).slice(0, 4000);
      tlog.error(`✗ ${lastError}`, { kind: lastKind, attempt });
    }

    // Трейс сохраняем при падении/flaky (или всегда в режиме "on")
    const keepTrace = cfg.TRACE_MODE === "on" || (cfg.TRACE_MODE === "on-failure" && (!ok || attempt > 1));
    if (session && (a.flags as StandFlags & { capture_storage?: boolean }).capture_storage) {
      try {
        storageDump = (await session.storageDump()) ?? storageDump;
      } catch {
        /* захват дампа не влияет на исход теста */
      }
    }
    const trace = session ? await session.close(keepTrace) : null;
    if (trace) tracePath = await artifacts.upload(Artifacts.path(run.id, test.id, attempt, "trace.zip"), trace, "application/zip");

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
  const ok = PASSED.includes(finalStatus);
  const shared = ok ? (outputs.get(test.scenario_key) ?? {}) : {};
  if (!ok) outputs.delete(test.scenario_key);

  await db
    .from("run_tests")
    .update({
      status: finalStatus,
      flaky: finalStatus === "flaky",
      error: lastError,
      error_kind: lastKind,
      duration_ms: Date.now() - started,
      trace_path: tracePath,
      outputs: maskSecrets(shared),
      finished_at: now(),
      hold_requested: false,
    })
    .eq("id", test.id);

  // Взятые фикстуры: после успешного теста возвращаем в пул, иначе — на очистку
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

  // Артефакт результата в реестр run_results — аддитивно и изолированно: сбой записи не меняет исход теста
  try {
    await recordResult(db, { run, stand, test, status: finalStatus, error: lastError, storageDump: ok ? storageDump : null });
  } catch (e) {
    tlog.warn(`Не удалось записать результат в реестр: ${(e as Error).message}`);
  }
  return finalStatus;
}

/** Шаги сценария: запись в run_steps, артефакты при падении, manual_hold. */
class Stepper {
  private idx = 0;

  constructor(private a: TestArgs & { session: TestSession; attempt: number; holdState: { holding: boolean } }) {}

  async step<T>(name: string, fn: () => Promise<T>, opts: StepOptions = {}): Promise<T> {
    const { run, test, deps, control, log, attempt, session } = this.a;
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
    session.netErrors.length = 0;
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
      session.assertSafe();
      await db.from("run_steps").update({ status: "passed", finished_at: now(), network_errors: [...session.netErrors] }).eq("id", row.id);
      return result;
    } catch (err) {
      let error = err as Error;
      const kind = classifyError(error);
      const shots = await this.capture(`step-${idx}`);

      // manual_hold при падении: сессия удерживается, инженер решает, что делать
      if (run.hold_on_failure && kind !== "cancelled" && kind !== "guard") {
        await db
          .from("run_steps")
          .update({ error: log.redact(error.message).slice(0, 4000), ...shots, network_errors: [...session.netErrors] })
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
          network_errors: [...session.netErrors],
          ...shots,
        })
        .eq("id", row.id);
      throw error;
    }
  }

  /** Скриншот (поля паролей замаскированы) и DOM / дерево экрана (известные секреты вырезаны). */
  private async capture(name: string): Promise<{ screenshot_path?: string; dom_path?: string }> {
    const { run, test, attempt, deps, session } = this.a;
    const out: { screenshot_path?: string; dom_path?: string } = {};
    const c = await session.capture();
    if (c.png) {
      const p = await deps.artifacts.upload(Artifacts.path(run.id, test.id, attempt, `${name}.png`), c.png, "image/png");
      if (p) out.screenshot_path = p;
    }
    if (c.source) {
      const p = await deps.artifacts.upload(
        Artifacts.path(run.id, test.id, attempt, `${name}.${c.source.ext}`),
        c.source.body,
        c.source.contentType,
      );
      if (p) out.dom_path = p;
    }
    return out;
  }

  private async hold(stepName: string): Promise<HoldAction> {
    const { stand, test, control, log, deps } = this.a;
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
