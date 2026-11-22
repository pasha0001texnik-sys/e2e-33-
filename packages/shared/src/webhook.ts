// Подпись вебхуков CI: HMAC-SHA256 от "<timestamp>.<raw body>".
// Заголовки: X-E2E-Timestamp (unix, сек) и X-E2E-Signature (sha256=<hex>).

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SEC = 300;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhook(opts: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, timestamp, signature, body } = opts;
  if (!secret) return { ok: false, reason: "WEBHOOK_SECRET не задан" };
  if (!timestamp || !signature) return { ok: false, reason: "Нет подписи" };
  const ts = Number(timestamp);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SEC) {
    return { ok: false, reason: "Метка времени вне допустимого окна" };
  }
  const expected = Buffer.from(signWebhook(secret, ts, body));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { ok: false, reason: "Неверная подпись" };
  }
  return { ok: true };
}
