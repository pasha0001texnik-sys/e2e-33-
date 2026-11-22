import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Profile, Role } from "@e2e/shared";
import { createClient } from "./supabase/server";

const RANK: Record<Role, number> = { viewer: 0, qa: 1, admin: 2 };

export function roleAtLeast(role: Role | undefined, min: Role) {
  return !!role && RANK[role] >= RANK[min];
}

/** Текущий пользователь и профиль; редирект на /login, если сессии нет. */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  return { supabase, user, profile: (profile ?? { id: user.id, email: user.email, role: "viewer" }) as Profile };
});

/** Для server actions: бросает ошибку вместо редиректа. */
export async function requireRole(min: Role) {
  const ctx = await requireUser();
  if (!roleAtLeast(ctx.profile.role, min)) {
    throw new Error(`Недостаточно прав: нужна роль ${min}`);
  }
  return ctx;
}
