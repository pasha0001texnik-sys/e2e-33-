// Вебхук из CI/CD по завершении сборки.
//
//   POST /api/webhooks/ci
//   X-E2E-Timestamp: <unix seconds>
//   X-E2E-Signature: sha256=<hex HMAC-SHA256(CI_WEBHOOK_SECRET, "<timestamp>.<raw body>")>
//   { "suite": "smoke-auth", "stand": "staging", "build_tag": "v1.42.0", "parallelism": 2, "idempotency_key": "gh-123-1" }
//
// Повторная доставка с тем же idempotency_key (по умолчанию suite+stand+build_tag) не создаёт дубль.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PRIORITY } from "@e2e/shared";
import { verifyWebhook } from "@e2e/shared/node";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";

const body = z.object({
  suite: z.string().min(1),
  stand: z.string().min(1),
  build_tag: z.string().trim().min(1).max(120).regex(/^[\w.\-+/:]+$/),
  parallelism: z.number().int().min(1).max(50).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const check = verifyWebhook({
    secret: serverEnv().webhookSecret,
    timestamp: request.headers.get("x-e2e-timestamp"),
    signature: request.headers.get("x-e2e-signature"),
    body: raw,
  });
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });

  let payload: z.infer<typeof body>;
  try {
    payload = body.parse(JSON.parse(raw));
  } catch (e) {
    return NextResponse.json({ error: "Некорректное тело запроса", details: (e as Error).message }, { status: 400 });
  }

  const db = createServiceClient();
  const [{ data: suite }, { data: stand }] = await Promise.all([
    db.from("suites").select("id, default_parallelism, max_retries").eq("slug", payload.suite).single(),
    db.from("stands").select("id, is_active, max_concurrency").eq("slug", payload.stand).single(),
  ]);
  if (!suite) return NextResponse.json({ error: `Сюит ${payload.suite} не найден` }, { status: 404 });
  if (!stand) return NextResponse.json({ error: `Стенд ${payload.stand} не найден` }, { status: 404 });
  if (!stand.is_active) return NextResponse.json({ error: `Стенд ${payload.stand} отключён` }, { status: 409 });

  const key = payload.idempotency_key ?? `ci:${payload.suite}:${payload.stand}:${payload.build_tag}`;
  const { data: existing } = await db.from("runs").select("id, number, status").eq("idempotency_key", key).maybeSingle();
  if (existing) return NextResponse.json({ ...existing, duplicate: true }, { status: 200 });

  const { data: run, error } = await db
    .from("runs")
    .insert({
      suite_id: suite.id,
      stand_id: stand.id,
      build_tag: payload.build_tag,
      trigger: "webhook",
      priority: PRIORITY.webhook,
      parallelism: Math.min(payload.parallelism ?? suite.default_parallelism, stand.max_concurrency),
      max_retries: payload.max_retries ?? suite.max_retries,
      idempotency_key: key,
    })
    .select("id, number, status")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: dup } = await db.from("runs").select("id, number, status").eq("idempotency_key", key).single();
      return NextResponse.json({ ...dup, duplicate: true }, { status: 200 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const origin = request.nextUrl.origin;
  return NextResponse.json({ ...run, url: `${origin}/runs/${run.id}` }, { status: 201 });
}
