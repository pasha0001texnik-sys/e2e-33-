import { LiveRefresh } from "@/components/LiveRefresh";
import { LinkButton, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { RunsTable, type RunRow } from "./RunsTable";

export const metadata = { title: "Прогоны" };

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; stand?: string; q?: string }>;
}) {
  const { supabase, profile } = await requireUser();
  const sp = await searchParams;

  let query = supabase
    .from("runs")
    .select(
      "id, number, status, trigger, build_tag, parallelism, summary, created_at, started_at, finished_at, error, suite:suites(name, slug), stand:stands(slug, name, env)",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.stand) query = query.eq("stand_id", sp.stand);
  if (sp.q) query = query.ilike("build_tag", `%${sp.q}%`);

  const [{ data: runs, error }, { data: stands }] = await Promise.all([
    query,
    supabase.from("stands").select("id, slug").order("slug"),
  ]);

  const active = (runs ?? []).filter((r) => ["queued", "running", "paused"].includes(r.status)).length;

  return (
    <>
      <LiveRefresh tables={["runs"]} />
      <PageHeader
        title="Прогоны"
        subtitle={active ? `${active} активных сейчас · обновляется в реальном времени` : "Все прогоны по стендам и сборкам"}
        actions={roleAtLeast(profile.role, "qa") && <LinkButton href="/runs/new" variant="primary">Запустить прогон</LinkButton>}
      />
      <form className="mb-4 flex flex-wrap gap-2">
        <select name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">Все статусы</option>
          {["queued", "running", "paused", "passed", "failed", "cancelled", "error"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="stand" defaultValue={sp.stand ?? ""} className="input w-auto">
          <option value="">Все стенды</option>
          {(stands ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.slug}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={sp.q ?? ""} placeholder="build_tag…" className="input w-48" />
        <button className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 hover:text-ink">Фильтр</button>
      </form>
      {error ? <p className="text-bad">{error.message}</p> : <RunsTable rows={(runs ?? []) as unknown as RunRow[]} />}
    </>
  );
}
