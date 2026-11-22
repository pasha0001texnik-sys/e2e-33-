import { NextResponse, type NextRequest } from "next/server";
import { maskSecrets } from "@e2e/shared";
import { createClient } from "@/lib/supabase/server";

// Выгрузка отчёта прогона для разбора дефектов: JSON (всё) или CSV (по шагам).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: run } = await supabase
    .from("runs")
    .select("*, suite:suites(name, slug), stand:stands(slug, name, env)")
    .eq("id", id)
    .single();
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [{ data: tests }, { data: steps }, { data: logs }, { data: fixtures }] = await Promise.all([
    supabase.from("run_tests").select("*").eq("run_id", id).order("created_at"),
    supabase.from("run_steps").select("*").eq("run_id", id).order("id"),
    supabase.from("run_logs").select("ts, level, message, run_test_id").eq("run_id", id).order("id").limit(20000),
    supabase.from("fixtures").select("id, kind, payload, status, created_at, cleaned_at").eq("run_id", id),
  ]);

  const name = `run-${run.number}-${run.stand?.slug ?? "stand"}-${String(run.build_tag).replace(/[^\w.-]+/g, "_")}`;

  if (format === "json") {
    const body = maskSecrets({ run, tests, steps, logs, fixtures, exported_at: new Date().toISOString() });
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.json"`,
      },
    });
  }

  const testById = new Map((tests ?? []).map((t) => [t.id, t]));
  const rows: (string | number | null)[][] = [
    ["run", "stand", "build_tag", "scenario", "test_status", "attempt", "step_idx", "step", "step_status", "started_at", "finished_at", "error", "network_errors", "screenshot"],
  ];
  for (const s of steps ?? []) {
    const t = testById.get(s.run_test_id);
    rows.push([
      run.number,
      run.stand?.slug ?? "",
      run.build_tag,
      t?.scenario_key ?? "",
      t?.status ?? "",
      s.attempt,
      s.idx,
      s.name,
      s.status,
      s.started_at,
      s.finished_at,
      s.error,
      (s.network_errors ?? []).length,
      s.screenshot_path,
    ]);
  }
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
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
