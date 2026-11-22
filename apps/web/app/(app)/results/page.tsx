import type { RunResult } from "@e2e/shared";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { ResultsTable, type ResultRow } from "./ResultsTable";

export const metadata = { title: "Результаты" };

const STATUSES = ["passed", "flaky", "failed", "skipped", "cancelled"];

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; run?: string; q?: string }>;
}) {
  const { supabase, profile } = await requireUser();
  const sp = await searchParams;

  // storage_dump не выбираем: колонка недоступна роли authenticated
  let query = supabase
    .from("run_results")
    .select(
      "id, run_id, run_test_id, scenario_key, status, form_fields, network_profile, region, error, created_at, run:runs(number, build_tag, stand:stands(slug))",
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.run) query = query.eq("run_id", sp.run);
  if (sp.q) query = query.ilike("scenario_key", `%${sp.q}%`);

  const [{ data, error }, { data: counts }] = await Promise.all([
    query,
    supabase.from("run_results").select("status").limit(5000),
  ]);
  const byStatus = new Map<string, number>();
  for (const c of counts ?? []) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

  return (
    <>
      <LiveRefresh tables={["run_results"]} />
      <PageHeader
        title="Результаты сценариев"
        subtitle="Артефакты выполнения: поля формы, сетевой профиль, регион, статус. Дамп cookies/storage доступен только в экспорте."
      />
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {STATUSES.map((s) => (
          <span key={s} className="rounded-md border border-line bg-panel px-2.5 py-1">
            {s} <b className="ml-1 tabular-nums">{byStatus.get(s) ?? 0}</b>
          </span>
        ))}
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <select name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">Все статусы</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={sp.q ?? ""} placeholder="сценарий…" className="input w-56" />
        <button className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 hover:text-ink">Фильтр</button>
      </form>
      {error ? (
        <p className="text-bad">{error.message}</p>
      ) : (
        <ResultsTable rows={(data ?? []) as unknown as ResultRow[]} isAdmin={roleAtLeast(profile.role, "admin")} />
      )}
    </>
  );
}
