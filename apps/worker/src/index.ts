import type { Run } from "@e2e/shared";
import { Artifacts } from "./artifacts.ts";
import { processCleanup } from "./cleanup.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { sysLog } from "./logger.ts";
import { executeRun } from "./runner.ts";
import { tickScheduler } from "./scheduler.ts";

const cfg = (() => {
  try {
    return loadConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
})();
const db = createDb(cfg);
const artifacts = new Artifacts(db, cfg);

let stopping = false;
const active = new Set<Promise<void>>();

async function claim(): Promise<Run | null> {
  const { data, error } = await db.rpc("worker_claim_run", { p_worker: cfg.WORKER_ID, p_platforms: cfg.WORKER_PLATFORMS });
  if (error) {
    sysLog.error("claim failed", { error: error.message });
    return null;
  }
  // функция возвращает составной тип: «пустой» результат приходит как объект с id = null
  const run = (Array.isArray(data) ? data[0] : data) as Run | null;
  return run?.id ? run : null;
}

async function pollLoop() {
  while (!stopping) {
    if (active.size < cfg.WORKER_MAX_RUNS) {
      const run = await claim();
      if (run) {
        sysLog.info("run claimed", { run_id: run.id, number: run.number, trace_id: run.trace_id });
        const p = executeRun(run, { db, cfg, artifacts })
          .catch((e) => sysLog.error("run crashed", { run_id: run.id, error: (e as Error).message }))
          .finally(() => active.delete(p));
        active.add(p);
        continue; // сразу пробуем взять ещё, если есть слоты
      }
    }
    await sleep(cfg.POLL_INTERVAL_MS);
  }
}

function every(ms: number, name: string, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return;
    try {
      await fn();
    } catch (e) {
      sysLog.error(`${name} failed`, { error: (e as Error).message });
    }
    if (!stopping) setTimeout(tick, ms);
  };
  setTimeout(tick, 1000);
}

async function main() {
  sysLog.info("worker started", { worker_id: cfg.WORKER_ID, max_runs: cfg.WORKER_MAX_RUNS, platforms: cfg.WORKER_PLATFORMS });
  if (cfg.ENABLE_SCHEDULER) every(30_000, "scheduler", () => tickScheduler(db));
  if (cfg.ENABLE_JANITOR) {
    every(60_000, "janitor", async () => {
      const { data, error } = await db.rpc("worker_janitor");
      if (error) throw new Error(error.message);
      const r = data as Record<string, number>;
      if (Object.values(r).some((v) => v > 0)) sysLog.info("janitor", r);
      await processCleanup(db);
    });
  }
  await pollLoop();
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  sysLog.info("shutting down: новые прогоны не берутся, ждём текущие", { signal, active: active.size });
  const timeout = sleep(10 * 60_000);
  await Promise.race([Promise.allSettled([...active]), timeout]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  sysLog.error("fatal", { error: (e as Error).message });
  process.exit(1);
});
