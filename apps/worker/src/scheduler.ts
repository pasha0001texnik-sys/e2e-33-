// Планировщик: превращает расписания (cron) в прогоны.
// Несколько воркеров могут работать одновременно: дубль отсекается уникальным idempotency_key.

import { PRIORITY, type Schedule } from "@e2e/shared";
import { CronExpressionParser } from "cron-parser";
import type { Db } from "./db.ts";
import { sysLog } from "./logger.ts";

export function nextFire(cron: string, tz: string, from: Date = new Date()): Date {
  return CronExpressionParser.parse(cron, { tz, currentDate: from }).next().toDate();
}

export async function tickScheduler(db: Db): Promise<number> {
  const { data, error } = await db.from("schedules").select("*").eq("enabled", true);
  if (error) throw new Error(`schedules: ${error.message}`);
  let fired = 0;
  const now = new Date();

  for (const s of (data ?? []) as Schedule[]) {
    let next: Date;
    try {
      if (!s.next_fire_at) {
        next = nextFire(s.cron, s.timezone, now);
        await db.from("schedules").update({ next_fire_at: next.toISOString() }).eq("id", s.id);
        continue;
      }
      next = new Date(s.next_fire_at);
      if (next > now) continue;
    } catch (e) {
      sysLog.error("Невалидное расписание, отключаю", { schedule: s.id, error: (e as Error).message });
      await db.from("schedules").update({ enabled: false }).eq("id", s.id);
      continue;
    }

    const { data: active } = await db
      .from("runs")
      .select("id, status")
      .eq("schedule_id", s.id)
      .in("status", ["queued", "running", "paused"]);
    const busy = (active ?? []) as { id: string; status: string }[];

    let create = true;
    if (busy.length) {
      if (s.overlap_policy === "skip") {
        create = false;
        sysLog.info("Расписание пропущено: предыдущий прогон ещё идёт", { schedule: s.id });
      } else if (s.overlap_policy === "cancel_previous") {
        for (const r of busy) {
          if (r.status === "queued") {
            await db.from("runs").update({ status: "cancelled", cancel_requested: true, finished_at: now.toISOString() }).eq("id", r.id);
          } else {
            await db.from("runs").update({ cancel_requested: true }).eq("id", r.id);
          }
        }
      }
    }

    if (create) {
      const { data: suite } = await db.from("suites").select("default_parallelism, max_retries").eq("id", s.suite_id).single();
      const { error: insErr } = await db.from("runs").insert({
        suite_id: s.suite_id,
        stand_id: s.stand_id,
        build_tag: s.build_tag,
        trigger: "schedule",
        priority: PRIORITY.schedule,
        parallelism: s.parallelism ?? suite?.default_parallelism ?? 1,
        max_retries: suite?.max_retries ?? 1,
        schedule_id: s.id,
        idempotency_key: `schedule:${s.id}:${next.toISOString()}`,
        created_by: s.created_by,
      });
      if (insErr && !insErr.message.includes("duplicate")) {
        sysLog.error("Не удалось создать прогон по расписанию", { schedule: s.id, error: insErr.message });
        continue;
      }
      if (!insErr) fired++;
    }

    await db
      .from("schedules")
      .update({ last_fired_at: now.toISOString(), next_fire_at: nextFire(s.cron, s.timezone, now).toISOString() })
      .eq("id", s.id);
  }
  return fired;
}
