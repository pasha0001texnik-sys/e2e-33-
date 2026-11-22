"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { SCENARIO_CATALOG } from "@e2e/shared";
import type { ActionState } from "@/components/forms";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

const known = new Set(SCENARIO_CATALOG.map((s) => s.key));

const suiteSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "slug: латиница в нижнем регистре, цифры и дефис"),
  name: z.string().trim().min(1, "Укажите название"),
  description: z.string().trim().transform((v) => v || null),
  scenario_keys: z
    .array(z.string())
    .min(1, "Выберите хотя бы один сценарий")
    .refine((keys) => keys.every((k) => known.has(k)), "Неизвестный сценарий"),
  tags: z.string().transform((v) => v.split(/[\s,]+/).filter(Boolean)),
  default_parallelism: z.coerce.number().int().min(1).max(50),
  max_retries: z.coerce.number().int().min(0).max(5),
  test_timeout_sec: z.coerce.number().int().min(10).max(3600),
});

export async function saveSuite(_: ActionState, data: FormData): Promise<ActionState> {
  try {
    const { supabase } = await requireRole("admin");
    const id = String(data.get("id") || "");
    const parsed = suiteSchema.safeParse({
      slug: data.get("slug"),
      name: data.get("name"),
      description: data.get("description") ?? "",
      scenario_keys: data.getAll("scenario_keys").map(String),
      tags: data.get("tags") ?? "",
      default_parallelism: data.get("default_parallelism"),
      max_retries: data.get("max_retries"),
      test_timeout_sec: data.get("test_timeout_sec"),
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message };
    const { error } = id
      ? await supabase.from("suites").update(parsed.data).eq("id", id)
      : await supabase.from("suites").insert(parsed.data);
    if (error) return { error: errText(error) };
    revalidatePath("/suites");
    return { ok: true, message: id ? "Сюит сохранён" : "Сюит создан" };
  } catch (e) {
    return { error: errText(e) };
  }
}
