"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { errText } from "@/lib/format";

export async function requestCleanup(ids: string[]): Promise<number> {
  const parsed = z.array(z.string().uuid()).min(1).max(500).parse(ids);
  const { supabase } = await requireRole("qa");
  const { data, error } = await supabase.rpc("request_fixture_cleanup", { p_ids: parsed });
  if (error) throw new Error(errText(error));
  revalidatePath("/fixtures");
  return data as number;
}
