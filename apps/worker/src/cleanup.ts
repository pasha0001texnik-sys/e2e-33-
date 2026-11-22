// Очистка тестовых записей на стендах через служебный API стенда (не через UI).
// Контракт: POST {cleanup_api_url} c JSON {fixture_id, kind, email, run_id}
// и заголовком Authorization: Bearer <секрет стенда cleanup_token>.
// 2xx и 404 (записи уже нет) считаются успехом — операция идемпотентна.

import { isRequestAllowed, type Fixture, type Stand } from "@e2e/shared";
import type { Db } from "./db.ts";
import { sysLog } from "./logger.ts";

const MAX_ATTEMPTS = 5;

export async function processCleanup(db: Db, limit = 25): Promise<{ cleaned: number; failed: number }> {
  const { data, error } = await db
    .from("fixtures")
    .select("*")
    .eq("status", "cleanup_pending")
    .order("updated_at")
    .limit(limit);
  if (error) throw new Error(`cleanup select: ${error.message}`);
  const fixtures = (data ?? []) as Fixture[];
  if (!fixtures.length) return { cleaned: 0, failed: 0 };

  const standIds = [...new Set(fixtures.map((f) => f.stand_id))];
  const { data: standRows } = await db.from("stands").select("*").in("id", standIds);
  const stands = new Map(((standRows ?? []) as Stand[]).map((s) => [s.id, s]));
  const tokens = new Map<string, string | undefined>();
  for (const id of standIds) {
    const { data: sec } = await db.rpc("worker_get_stand_secrets", { p_stand: id });
    tokens.set(id, ((sec ?? []) as { name: string; value: string }[]).find((s) => s.name === "cleanup_token")?.value);
  }

  let cleaned = 0;
  let failed = 0;
  for (const fx of fixtures) {
    const stand = stands.get(fx.stand_id);
    const attempts = fx.cleanup_attempts + 1;
    const fail = async (msg: string) => {
      failed++;
      await db
        .from("fixtures")
        .update({
          cleanup_attempts: attempts,
          last_error: msg.slice(0, 2000),
          status: attempts >= MAX_ATTEMPTS ? "failed" : "cleanup_pending",
        })
        .eq("id", fx.id);
    };

    if (!stand?.cleanup_api_url) {
      await fail("У стенда не настроен cleanup_api_url — удалите запись вручную");
      continue;
    }
    if (!isRequestAllowed(stand.cleanup_api_url, stand.allowed_hosts)) {
      await fail("cleanup_api_url вне allowlist стенда");
      continue;
    }
    try {
      const token = tokens.get(stand.id);
      const res = await fetch(stand.cleanup_api_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ fixture_id: fx.id, kind: fx.kind, email: fx.payload.email ?? null, run_id: fx.run_id }),
        signal: AbortSignal.timeout(15000),
        redirect: "manual", // не следуем за редиректами за пределы стенда
      });
      if (res.ok || res.status === 404) {
        cleaned++;
        await db
          .from("fixtures")
          .update({ status: "cleaned", cleaned_at: new Date().toISOString(), cleanup_attempts: attempts, last_error: null })
          .eq("id", fx.id);
      } else {
        await fail(`Стенд ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
    } catch (e) {
      await fail(`Ошибка запроса очистки: ${(e as Error).message}`);
    }
  }
  if (cleaned || failed) sysLog.info("cleanup", { cleaned, failed });
  return { cleaned, failed };
}
