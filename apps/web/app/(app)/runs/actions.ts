"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/forms";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

const newRun = z.object({
  suite_id: z.string().uuid("Выберите сюит"),
  stand_id: z.string().uuid("Выберите стенд"),
  build_tag: z
    .string()
    .trim()
    .min(1, "Укажите build_tag")
    .max(120)
    .regex(/^[\w.\-+/:]+$/, "Допустимы буквы, цифры и . - + / : _"),
  parallelism: z.coerce.number().int().min(1).max(50),
  max_retries: z.coerce.number().int().min(0).max(5),
  hold_on_failure: z.boolean(),
  fixture_template: z.string().max(60).optional(),
  only_scenarios: z.array(z.string()).optional(),
});

export async function createRun(_: ActionState, data: FormData): Promise<ActionState> {
  let id: string;
  try {
    const { supabase, user } = await requireRole("qa");
    const only = data.getAll("only_scenarios").map(String).filter(Boolean);
    if (data.get("scenarios_shown") && !only.length) return { error: "Выберите хотя бы один сценарий" };
    const parsed = newRun.safeParse({
      suite_id: data.get("suite_id"),
      stand_id: data.get("stand_id"),
      build_tag: data.get("build_tag"),
      parallelism: data.get("parallelism"),
      max_retries: data.get("max_retries"),
      hold_on_failure: data.get("hold_on_failure") === "on",
      fixture_template: data.get("fixture_template") ? String(data.get("fixture_template")) : undefined,
      only_scenarios: only.length ? only : undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message };

    const { data: stand } = await supabase.from("stands").select("is_active, max_concurrency").eq("id", parsed.data.stand_id).single();
    if (!stand?.is_active) return { error: "Стенд отключён" };

    const { data: run, error } = await supabase
      .from("runs")
      .insert({
        ...parsed.data,
        only_scenarios: parsed.data.only_scenarios ?? null,
        fixture_template: parsed.data.fixture_template ?? null,
        parallelism: Math.min(parsed.data.parallelism, stand.max_concurrency),
        created_by: user.id,
        trigger: "manual",
        status: "queued",
      })
      .select("id")
      .single();
    if (error) return { error: errText(error) };
    id = run.id;
  } catch (e) {
    return { error: errText(e) };
  }
  revalidatePath("/runs");
  redirect(`/runs/${id}`);
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { supabase } = await requireRole("qa");
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(errText(error));
  return data;
}

export async function cancelRun(runId: string) {
  await rpc("cancel_run", { p_run: runId });
  revalidatePath(`/runs/${runId}`);
}

export async function setPaused(runId: string, paused: boolean) {
  await rpc("set_run_paused", { p_run: runId, p_paused: paused });
  revalidatePath(`/runs/${runId}`);
}

export async function rerunFailed(runId: string) {
  const newId = (await rpc("rerun_failed", { p_run: runId })) as string;
  redirect(`/runs/${newId}`);
}

export async function respondHold(testId: string, action: "continue" | "fail" | "abort") {
  await rpc("respond_hold", { p_test: testId, p_action: action });
}

export async function requestHold(testId: string, requested: boolean) {
  await rpc("request_hold", { p_test: testId, p_requested: requested });
}
