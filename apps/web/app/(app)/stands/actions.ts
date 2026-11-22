"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertStandSafe, GuardError, STAND_ENVS } from "@e2e/shared";
import type { ActionState } from "@/components/forms";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

const optUrl = z
  .string()
  .trim()
  .transform((v) => v || null)
  .pipe(z.string().url("Некорректный URL").nullable());

const jsonObj = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (!v) return {};
      try {
        const o = JSON.parse(v);
        if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
      } catch {
        /* ниже */
      }
      ctx.addIssue({ code: "custom", message: `${label}: нужен JSON-объект` });
      return z.NEVER;
    });

const standSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "slug: латиница в нижнем регистре, цифры и дефис"),
  name: z.string().trim().min(1, "Укажите название"),
  env: z.enum(STAND_ENVS),
  base_url: z.string().trim().url("Некорректный базовый URL"),
  allowed_hosts: z
    .string()
    .transform((v) => v.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/, "Хост: example.test или *.example.test")).min(1, "Нужен хотя бы один хост")),
  health_url: optUrl,
  expected_env_marker: z.string().trim().transform((v) => v || null),
  mail_domain: z.string().trim().transform((v) => v.toLowerCase() || null),
  mailbox_api_url: optUrl,
  cleanup_api_url: optUrl,
  max_concurrency: z.coerce.number().int().min(1).max(50),
  max_holds: z.coerce.number().int().min(0).max(10),
  rps_limit: z.coerce.number().int().min(0).max(10000).transform((v) => v || null),
  fixture_ttl_minutes: z.coerce.number().int().min(5).max(10080),
  quiet_from: z.string().trim(),
  quiet_to: z.string().trim(),
  quiet_tz: z.string().trim(),
  quiet_days: z.array(z.coerce.number().int().min(1).max(7)),
  mocks: jsonObj("Моки"),
  test_flags: jsonObj("Флаги"),
  is_active: z.boolean(),
});

export async function saveStand(_: ActionState, data: FormData): Promise<ActionState> {
  let savedId: string;
  try {
    const { supabase } = await requireRole("admin");
    const id = String(data.get("id") || "");
    const parsed = standSchema.safeParse({
      ...Object.fromEntries(
        [...data.entries()].filter(([k]) => !["quiet_days", "is_active"].includes(k)).map(([k, v]) => [k, String(v)]),
      ),
      quiet_days: data.getAll("quiet_days").map(String),
      is_active: data.get("is_active") === "on",
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message };
    const { quiet_from, quiet_to, quiet_tz, quiet_days, ...rest } = parsed.data;
    const stand = {
      ...rest,
      quiet_hours:
        quiet_from && quiet_to
          ? { tz: quiet_tz || "Europe/Moscow", from: quiet_from, to: quiet_to, ...(quiet_days.length ? { days: quiet_days } : {}) }
          : null,
    };

    const { data: forbidden } = await supabase.from("forbidden_hosts").select("pattern");
    try {
      assertStandSafe(stand, (forbidden ?? []).map((f) => f.pattern));
    } catch (e) {
      if (e instanceof GuardError) return { error: e.message };
      throw e;
    }

    if (id) {
      const { error } = await supabase.from("stands").update(stand).eq("id", id);
      if (error) return { error: errText(error) };
      savedId = id;
    } else {
      const { data: row, error } = await supabase.from("stands").insert(stand).select("id").single();
      if (error) return { error: errText(error) };
      savedId = row.id;
    }
  } catch (e) {
    return { error: errText(e) };
  }
  revalidatePath("/stands");
  redirect(`/stands/${savedId}?saved=1`);
}

export async function setSecret(_: ActionState, data: FormData): Promise<ActionState> {
  try {
    const { supabase } = await requireRole("admin");
    const stand = String(data.get("stand_id"));
    const name = String(data.get("name") ?? "").trim();
    const value = String(data.get("value") ?? "");
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(name)) return { error: "Имя: латиница в нижнем регистре и _, например cleanup_token" };
    if (!value) return { error: "Пустое значение" };
    const { error } = await supabase.rpc("set_stand_secret", { p_stand: stand, p_name: name, p_value: value });
    if (error) return { error: errText(error) };
    revalidatePath(`/stands/${stand}`);
    return { ok: true, message: `Секрет ${name} сохранён` };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function deleteSecret(standId: string, name: string) {
  const { supabase } = await requireRole("admin");
  const { error } = await supabase.rpc("delete_stand_secret", { p_stand: standId, p_name: name });
  if (error) throw new Error(errText(error));
  revalidatePath(`/stands/${standId}`);
}

export async function addForbiddenHost(_: ActionState, data: FormData): Promise<ActionState> {
  try {
    const { supabase } = await requireRole("admin");
    const pattern = String(data.get("pattern") ?? "").trim().toLowerCase();
    if (!/^(\*\.)?[a-z0-9.-]+\.[a-z0-9-]+$/.test(pattern)) return { error: "Формат: example.com или *.example.com" };
    const { error } = await supabase.from("forbidden_hosts").insert({ pattern, note: String(data.get("note") ?? "") || null });
    if (error) return { error: errText(error) };
    revalidatePath("/stands");
    return { ok: true, message: `${pattern} запрещён` };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function removeForbiddenHost(pattern: string) {
  const { supabase } = await requireRole("admin");
  const { error } = await supabase.from("forbidden_hosts").delete().eq("pattern", pattern);
  if (error) throw new Error(errText(error));
  revalidatePath("/stands");
}
