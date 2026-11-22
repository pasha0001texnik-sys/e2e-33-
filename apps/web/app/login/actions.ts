"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/forms";
import { createClient } from "@/lib/supabase/server";

const creds = z.object({
  email: z.string().email("Введите корректный email"),
  password: z.string().min(8, "Пароль — минимум 8 символов"),
});

function safeNext(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/runs";
}

export async function signIn(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = creds.safeParse({ email: data.get("email"), password: data.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Неверный email или пароль" };
  redirect(safeNext(data.get("next")));
}

export async function signUp(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = creds.safeParse({ email: data.get("email"), password: data.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const origin = (await headers()).get("origin") ?? "";
  const { data: res, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) return { error: error.message };
  if (!res.session) return { ok: true, message: "Проверьте почту и подтвердите адрес, затем войдите" };
  redirect("/runs");
}

export async function magicLink(_: ActionState, data: FormData): Promise<ActionState> {
  const email = z.string().email().safeParse(data.get("email"));
  if (!email.success) return { error: "Введите корректный email" };
  const supabase = await createClient();
  const origin = (await headers()).get("origin") ?? "";
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext(data.get("next")))}`, shouldCreateUser: false },
  });
  if (error) return { error: error.message };
  return { ok: true, message: "Ссылка для входа отправлена на почту" };
}
