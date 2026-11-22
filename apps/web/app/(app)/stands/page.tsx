import Link from "next/link";
import type { Stand } from "@e2e/shared";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge, Card, Empty, LinkButton, Mono, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { addForbiddenHost, removeForbiddenHost } from "./actions";

export const metadata = { title: "Стенды" };

export default async function StandsPage() {
  const { supabase, profile } = await requireUser();
  const isAdmin = roleAtLeast(profile.role, "admin");
  const [{ data: stands }, { data: forbidden }, { data: running }] = await Promise.all([
    supabase.from("stands").select("*").order("env").order("slug"),
    supabase.from("forbidden_hosts").select("*").order("pattern"),
    supabase.from("runs").select("stand_id, parallelism").in("status", ["running", "paused"]),
  ]);
  const load = new Map<string, number>();
  for (const r of running ?? []) load.set(r.stand_id, (load.get(r.stand_id) ?? 0) + r.parallelism);

  return (
    <>
      <PageHeader
        title="Стенды"
        subtitle="Тестовые окружения. Воркер ходит только на хосты из allowlist стенда."
        actions={isAdmin && <LinkButton href="/stands/new" variant="primary">Добавить стенд</LinkButton>}
      />
      {!stands?.length ? (
        <Empty>Стендов нет. {isAdmin ? "Добавьте первый." : "Попросите администратора добавить."}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(stands as Stand[]).map((s) => {
            const used = load.get(s.id) ?? 0;
            return (
              <Link key={s.id} href={`/stands/${s.id}`} className="rounded-lg border border-line bg-panel p-4 transition hover:border-ink-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <Badge tone={s.env === "staging" ? "warn" : s.env === "qa" ? "info" : "muted"}>{s.env}</Badge>
                    {s.platform && s.platform !== "web" && <Badge tone="hold">{s.platform}</Badge>}
                  </div>
                  {!s.is_active && <Badge tone="bad">отключён</Badge>}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-ink-3">{s.base_url}</div>
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-ink-3">
                    <span>Потоки</span>
                    <span className="tabular-nums">
                      {used}/{s.max_concurrency}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full bg-accent" style={{ width: `${Math.min(100, (used / s.max_concurrency) * 100)}%` }} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {s.health_url ? <Badge tone="ok">health</Badge> : <Badge tone="warn">без health</Badge>}
                  {s.mailbox_api_url && <Badge>почта</Badge>}
                  {s.cleanup_api_url ? <Badge>cleanup API</Badge> : <Badge tone="warn">без cleanup</Badge>}
                  {s.quiet_hours && (
                    <Badge>
                      тихо {s.quiet_hours.from}–{s.quiet_hours.to}
                    </Badge>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <Card title="Запрещённые хосты (production)" className="mt-8">
        <p className="mb-4 text-sm text-ink-2">
          Стенд не может разрешить эти хосты ни в allowlist, ни в URL — проверка в базе и в воркере.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          {(forbidden ?? []).map((f) => (
            <span key={f.pattern} className="inline-flex items-center gap-2 rounded-md border border-bad/30 bg-bad/5 px-2.5 py-1 text-sm">
              <Mono>{f.pattern}</Mono>
              {f.note && <span className="text-xs text-ink-3">{f.note}</span>}
              {isAdmin && (
                <ConfirmButton
                  confirm={`Убрать ${f.pattern} из запрещённых?`}
                  action={removeForbiddenHost.bind(null, f.pattern)}
                  className="text-ink-3 hover:text-bad"
                >
                  ×
                </ConfirmButton>
              )}
            </span>
          ))}
          {!forbidden?.length && <span className="text-sm text-warn">Список пуст — добавьте production-домены</span>}
        </div>
        {isAdmin && (
          <ActionForm action={addForbiddenHost} resetOnSuccess className="flex flex-wrap items-start gap-2">
            <input name="pattern" placeholder="example.com или *.example.com" className="input w-64 font-mono" required />
            <input name="note" placeholder="заметка" className="input w-56" />
            <SubmitButton variant="secondary">Запретить</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </>
  );
}
