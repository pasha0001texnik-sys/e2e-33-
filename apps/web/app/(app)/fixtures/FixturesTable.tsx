"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { Fixture } from "@e2e/shared";
import { Button, Empty, Mono, StatusBadge } from "@/components/ui";
import { fmtAgo, fmtDate } from "@/lib/format";
import { requestCleanup } from "./actions";

type Row = Fixture & { stand: { slug: string } | null; run: { number: number } | null };

export function FixturesTable({ rows, canCleanup }: { rows: Row[]; canCleanup: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const selectable = rows.filter((r) => !["cleaned", "in_use", "cleanup_pending"].includes(r.status));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!rows.length) return <Empty>Фикстур нет</Empty>;

  return (
    <>
      {canCleanup && (
        <div className="mb-3 flex items-center gap-3">
          <Button
            variant="danger"
            size="sm"
            disabled={!selected.size || pending}
            onClick={() =>
              confirm(`Удалить ${selected.size} записей со стенда через cleanup API?`) &&
              start(async () => {
                try {
                  const n = await requestCleanup([...selected]);
                  setMsg(`В очередь на очистку: ${n}`);
                  setSelected(new Set());
                } catch (e) {
                  setMsg((e as Error).message);
                }
              })
            }
          >
            Очистить выбранные ({selected.size})
          </Button>
          {msg && <span className="text-sm text-ink-2">{msg}</span>}
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {canCleanup && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    checked={selectable.length > 0 && selected.size === selectable.length}
                    onChange={(e) => setSelected(new Set(e.target.checked ? selectable.map((r) => r.id) : []))}
                  />
                </th>
              )}
              <th>Статус</th>
              <th>Email</th>
              <th>Стенд</th>
              <th>Прогон</th>
              <th>Сборка</th>
              <th>Истекает</th>
              <th>Создана</th>
              <th>Ошибка очистки</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {canCleanup && (
                  <td>
                    <input
                      type="checkbox"
                      disabled={!selectable.includes(r)}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                )}
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>
                  <Mono>{String(r.payload.email ?? "—")}</Mono>
                  <div className="text-xs text-ink-3">{r.kind}</div>
                </td>
                <td>
                  <Mono>{r.stand?.slug}</Mono>
                </td>
                <td>
                  {r.run_id ? (
                    <Link href={`/runs/${r.run_id}`} className="font-mono text-info hover:underline">
                      #{r.run?.number}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <Mono className="text-ink-2">{r.build_tag ?? "—"}</Mono>
                </td>
                <td className="whitespace-nowrap text-ink-2">{r.status === "cleaned" ? "—" : fmtAgo(r.expires_at)}</td>
                <td className="whitespace-nowrap text-ink-3">{fmtDate(r.created_at)}</td>
                <td className="max-w-xs truncate text-xs text-bad" title={r.last_error ?? ""}>
                  {r.last_error && `${r.cleanup_attempts}× ${r.last_error}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
