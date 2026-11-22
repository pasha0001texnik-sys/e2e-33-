import { redirect } from "next/navigation";
import type { AuditEntry } from "@e2e/shared";
import { Empty, Mono, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Аудит" };

export default async function AuditPage() {
  const { supabase, profile } = await requireUser();
  if (!roleAtLeast(profile.role, "admin")) redirect("/runs");
  const [{ data }, { data: people }] = await Promise.all([
    supabase.from("audit_log").select("*").order("at", { ascending: false }).limit(300),
    supabase.from("profiles").select("id, email"),
  ]);
  const emails = new Map((people ?? []).map((p) => [p.id, p.email]));
  const rows = (data ?? []) as AuditEntry[];

  return (
    <>
      <PageHeader title="Аудит" subtitle="Изменения стендов, секретов, сюитов, расписаний и действия над прогонами" />
      {!rows.length ? (
        <Empty>Записей нет</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-ink-3">{fmtDate(r.at)}</td>
                  <td>{r.actor ? (emails.get(r.actor) ?? <Mono>{r.actor.slice(0, 8)}</Mono>) : <span className="text-ink-3">система</span>}</td>
                  <td>
                    <Mono>{r.action}</Mono>
                  </td>
                  <td>
                    <Mono className="text-ink-2">
                      {r.entity}
                      {r.entity_id && ` · ${r.entity_id.slice(0, 8)}`}
                    </Mono>
                  </td>
                  <td className="max-w-md truncate font-mono text-xs text-ink-3" title={r.data ? JSON.stringify(r.data) : ""}>
                    {r.data ? JSON.stringify(r.data) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
