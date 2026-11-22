import type { Fixture } from "@e2e/shared";
import { PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { FixturesTable } from "./FixturesTable";

export const metadata = { title: "Фикстуры" };

const STATUSES = ["created", "verified", "in_use", "cleanup_pending", "cleaned", "failed", "orphaned"];

export default async function FixturesPage({ searchParams }: { searchParams: Promise<{ status?: string; stand?: string; q?: string }> }) {
  const { supabase, profile } = await requireUser();
  const sp = await searchParams;
  let query = supabase
    .from("fixtures")
    .select("id, stand_id, run_id, build_tag, kind, payload, status, expires_at, cleanup_attempts, last_error, created_at, cleaned_at, stand:stands(slug), run:runs(number)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (sp.status) query = query.eq("status", sp.status);
  else query = query.neq("status", "cleaned");
  if (sp.stand) query = query.eq("stand_id", sp.stand);
  if (sp.q) query = query.ilike("payload->>email", `%${sp.q}%`);

  const [{ data, error }, { data: stands }, { data: counts }] = await Promise.all([
    query,
    supabase.from("stands").select("id, slug").order("slug"),
    supabase.from("fixtures").select("status").neq("status", "cleaned").limit(5000),
  ]);
  const byStatus = new Map<string, number>();
  for (const c of counts ?? []) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

  return (
    <>
      <PageHeader
        title="Фикстуры"
        subtitle="Синтетические тестовые записи на стендах. Истёкшие по TTL и записи упавших прогонов очищаются автоматически."
      />
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {STATUSES.filter((s) => s !== "cleaned").map((s) => (
          <span key={s} className="rounded-md border border-line bg-panel px-2.5 py-1">
            {s} <b className="ml-1 tabular-nums">{byStatus.get(s) ?? 0}</b>
          </span>
        ))}
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <select name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">Все, кроме cleaned</option>
          {STATUSES.map((s) => (
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
        <input name="q" defaultValue={sp.q ?? ""} placeholder="email…" className="input w-56" />
        <button className="h-9 rounded-md border border-line px-3 text-sm text-ink-2 hover:text-ink">Фильтр</button>
      </form>
      {error ? (
        <p className="text-bad">{error.message}</p>
      ) : (
        <FixturesTable
          rows={(data ?? []) as unknown as (Fixture & { stand: { slug: string } | null; run: { number: number } | null })[]}
          canCleanup={roleAtLeast(profile.role, "qa")}
        />
      )}
    </>
  );
}
