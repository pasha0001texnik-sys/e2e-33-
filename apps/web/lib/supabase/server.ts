import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { assertPublicEnv, serverEnv, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../env";

/** Клиент от имени вошедшего пользователя (RLS применяется). */
export async function createClient() {
  // cookies() первым: так Next помечает маршрут динамическим и не пытается пререндерить его при сборке
  const store = await cookies();
  assertPublicEnv();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // вызов из Server Component: cookies обновит proxy.ts
        }
      },
    },
  });
}

/**
 * Сервисный клиент (обходит RLS). Только для вебхука CI и выдачи ссылок на артефакты
 * после проверки прав. Никогда не передавайте его в клиентские компоненты.
 */
export function createServiceClient() {
  const { serviceRoleKey } = serverEnv();
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY не задан");
  return createPlainClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
