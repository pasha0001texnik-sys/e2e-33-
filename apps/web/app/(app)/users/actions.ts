"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ROLES } from "@e2e/shared";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

export async function setRole(userId: string, role: string) {
  const { supabase } = await requireRole("admin");
  const parsed = z.object({ userId: z.string().uuid(), role: z.enum(ROLES) }).parse({ userId, role });
  const { error } = await supabase.rpc("set_user_role", { p_user: parsed.userId, p_role: parsed.role });
  if (error) throw new Error(errText(error));
  revalidatePath("/users");
}
