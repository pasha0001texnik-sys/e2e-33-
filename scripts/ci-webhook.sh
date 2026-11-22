#!/usr/bin/env bash
# Запуск прогона из CI после сборки.
#   E2E_HUB_URL=https://e2e.example.app CI_WEBHOOK_SECRET=... ./scripts/ci-webhook.sh smoke-auth staging v1.42.0
set -euo pipefail
suite="$1"; stand="$2"; build="$3"
body=$(printf '{"suite":"%s","stand":"%s","build_tag":"%s","idempotency_key":"%s"}' \
  "$suite" "$stand" "$build" "${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$suite-$stand")
ts=$(date +%s)
sig="sha256=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$CI_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -fsS -X POST "$E2E_HUB_URL/api/webhooks/ci" \
  -H "Content-Type: application/json" -H "X-E2E-Timestamp: $ts" -H "X-E2E-Signature: $sig" \
  --data "$body"
echo
