import { NextResponse, type NextRequest } from "next/server";
import { maskSecrets } from "@e2e/shared";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

// Экспорт выбранных результатов сценариев в JSON или CSV.
// storage_dump (cookies/localStorage) включается только по явному запросу админа (dump=1).
export async function GET(request: NextRequest) {
  const { supabase, profile } = await requireUser();
  const url = request.nextUrl;
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const wantDump = url.searchParams.get("dump") === "1";
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
    .slice(0, 5000);
  if (!ids.length) return NextResponse.json({ error: "no ids" }, { status: 400 });

  const COLUMNS =
    "id, run_id, run_test_id, scenario_key, status, form_fields, network_profile, region, error, created_at, run:runs(number, build_tag, stand:stands(slug))";
  const { data, error } = await supabase.from("run_results").select(COLUMNS).in("id", ids).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as Record<string, unknown>[];

  // Дамп — отдельным защищённым запросом и только для админа
  const includeDump = wantDump && roleAtLeast(profile.role, "admin");
  if (includeDump) {
    const svc = createServiceClient();
    const { data: dumps } = await svc.from("run_results").select("id, storage_dump").in("id", ids);
    const byId = new Map((dumps ?? []).map((d: { id: string; storage_dump: unknown }) => [d.id, d.storage_dump]));
    for (const r of rows) r.storage_dump = byId.get(r.id as string) ?? {};
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `run-results-${stamp}`;

  if (format === "json") {
    const body = maskSecrets({ results: rows, count: rows.length, with_storage_dump: includeDump, exported_at: new Date().toISOString() });
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}.json"` },
    });
  }

  const masked = maskSecrets(rows) as Record<string, unknown>[];
  const header = ["id", "run_number", "build_tag", "stand", "scenario_key", "status", "region", "network_profile", "form_fields", "error", "created_at"];
  if (includeDump) header.push("storage_dump");
  const lines: (string | number | null)[][] = [header];
  for (const r of masked) {
    const run = r.run as { number?: number; build_tag?: string; stand?: { slug?: string } } | null;
    const row: (string | number | null)[] = [
      r.id as string,
      run?.number ?? "",
      run?.build_tag ?? "",
      run?.stand?.slug ?? "",
      r.scenario_key as string,
      r.status as string,
      (r.region as string) ?? "",
      JSON.stringify(r.network_profile ?? {}),
      JSON.stringify(r.form_fields ?? {}),
      (r.error as string) ?? "",
      r.created_at as string,
    ];
    if (includeDump) row.push(JSON.stringify(r.storage_dump ?? {}));
    lines.push(row);
  }
  const csv = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
  return new NextResponse(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` },
  });
}

function csvCell(v: string | number | null | undefined) {
  if (v == null) return "";
  let s = String(v);
  // защита от CSV-инъекций в Excel
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
