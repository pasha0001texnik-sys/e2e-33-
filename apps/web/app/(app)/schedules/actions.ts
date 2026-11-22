"use server";

import { CronExpressionParser } from "cron-parser";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/forms";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

const schema = z.object({
  suite_id: z.string().uuid("Выберите сюит"),
  stand_id: z.string().uuid("Выберите стенд"),
  cron: z.string().trim().min(9, "Укажите cron-выражение"),
  timezone: z.string().trim().min(1),
  build_tag: z.string().trim().min(1).max(120).regex(/^[\w.\-+/:]+$/),
  overlap_policy: z.enum(["skip", "queue", "cancel_previous"]),
  parallelism: z.coerce.number().int().min(0).max(50).transform((v) => v || null),
});

export async function createSchedule(_: ActionState, data: FormData): Promise<ActionState> {
  try {
    const { supabase, user } = await requireRole("qa");
    const parsed = schema.safeParse(Object.fromEntries(data));
    if (!parsed.success) return { error: parsed.error.issues[0]?.message };
    let next: Date;
    try {
      const it = CronExpressionParser.parse(parsed.data.cron, { tz: parsed.data.timezone });
      next = it.next().toDate();
      const after = it.next().toDate();
      if (after.getTime() - next.getTime() < 10 * 60_000) return { error: "Слишком частое расписание: минимум раз в 10 минут" };
    } catch (e) {
      return { error: `Некорректный cron или часовой пояс: ${(e as Error).message}` };
    }
    const { error } = await supabase
      .from("schedules")
      .insert({ ...parsed.data, created_by: user.id, next_fire_at: next.toISOString() });
    if (error) return { error: errText(error) };
    revalidatePath("/schedules");
    return { ok: true, message: `Расписание создано, первый запуск ${next.toLocaleString("ru-RU", { timeZone: parsed.data.timezone })}` };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function toggleSchedule(id: string, enabled: boolean) {
  const { supabase } = await requireRole("qa");
  const patch: Record<string, unknown> = { enabled };
  if (enabled) patch.next_fire_at = null; // воркер пересчитает от текущего момента
  const { error } = await supabase.from("schedules").update(patch).eq("id", id);
  if (error) throw new Error(errText(error));
  revalidatePath("/schedules");
}

export async function deleteSchedule(id: string) {
  const { supabase } = await requireRole("qa");
  const { error } = await supabase.from("schedules").delete().eq("id", id);
  if (error) throw new Error(errText(error));
  revalidatePath("/schedules");
}
