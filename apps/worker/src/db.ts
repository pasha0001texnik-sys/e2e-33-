import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.ts";

export type Db = SupabaseClient;

export function createDb(cfg: Config): Db {
  return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Бросает ошибку Supabase как исключение и возвращает данные. */
export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}
