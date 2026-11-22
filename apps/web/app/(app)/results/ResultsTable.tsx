"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { NetworkProfile, RunResult, TestStatus } from "@e2e/shared";
import { Button, Empty, Mono, StatusBadge } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export interface ResultRow extends Pick<RunResult, "id" | "run_id" | "run_test_id" | "scenario_key" | "status" | "region" | "error" | "created_at"> {
  form_fields: Record<string, unknown>;
  network_profile: NetworkProfile;
  run: { number: number; build_tag: string; stand: { slug: string } | null } | null;
}

function profileLabel(p: NetworkProfile): string {
  if (p.offline) return "offline";
  const parts: string[] = [];
  if (p.download) parts.push(`${Math.round(p.download / 125)} кбит/с`);
  if (p.latency) parts.push(`+${p.latency} мс`);
  return parts.join(" · ") || "обычный";
}

function Person({ f }: { f: Record<string, unknown> }) {
  const s = (k: string) => (f?.[k] == null ? "" : String(f[k]));
  const name = [s("first_name"), s("last_name")].filter(Boolean).join(" ");
  if (!name && !s("login")) return <span className="text-ink-3">—</span>;
  return (
    <div className="leading-tight">
      <div>{name || "—"}</div>
      <div className="font-mono text-xs text-ink-3">
        {[s("login"), s("gender"), s("birth_date"), s("locale")].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

export function ResultsTable({ rows, isAdmin }: { rows: ResultRow[]; isAdmin: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withSecrets, setWithSecrets] = useState(false);
  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportUrl = (format: "json" | "csv") => {
    const ids = selected.size ? [...selected] : allIds;
    const qs = new URLSearchParams({ format, ids: ids.join(",") });
    if (withSecrets) qs.set("secrets", "1");
    return `/api/results/export?${qs.toString()}`;
  };

  if (!rows.length) return <Empty>Результатов пока нет. Они появляются по мере выполнения сценариев.</Empty>;

  const count = selected.size || rows.length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-2">
          {selected.size ? `Выбрано: ${selected.size}` : `Все: ${rows.length}`}
        </span>
        <a href={exportUrl("json")} className="h-7 rounded-md border border-line px-2.5 text-xs leading-7 text-ink-2 hover:text-ink">
          Экспорт JSON ({count})
        </a>
        <a href={exportUrl("csv")} className="h-7 rounded-md border border-line px-2.5 text-xs leading-7 text-ink-2 hover:text-ink">
          Экспорт CSV ({count})
        </a>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Сбросить выбор
          </Button>
        )}
        {isAdmin && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-3" title="Пароль и дамп cookies/localStorage тестовых аккаунтов попадут в экспорт в открытом виде">
            <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
            включить секреты (пароль, cookies/storage)
          </label>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={(e) => setSelected(new Set(e.target.checked ? allIds : []))}
                />
              </th>
              <th>Статус</th>
              <th>Сценарий</th>
              <th>Личность</th>
              <th>Прогон</th>
              <th>Стенд</th>
              <th>Сетевой профиль</th>
              <th>Регион</th>
              <th>Ошибка</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>
                  <Mono>{r.scenario_key}</Mono>
                </td>
                <td>
                  <Person f={r.form_fields} />
                </td>
                <td>
                  {r.run_id ? (
                    <Link href={`/runs/${r.run_id}`} className="font-mono text-info hover:underline">
                      #{r.run?.number}
                    </Link>
                  ) : (
                    "—"
                  )}
                  {r.run?.build_tag && <div className="font-mono text-xs text-ink-3">{r.run.build_tag}</div>}
                </td>
                <td>
                  <Mono>{r.run?.stand?.slug ?? "—"}</Mono>
                </td>
                <td className="text-ink-2">{profileLabel(r.network_profile)}</td>
                <td className="text-ink-2">{r.region ?? "—"}</td>
                <td className="max-w-xs truncate text-xs text-bad" title={r.error ?? ""}>
                  {r.error ?? ""}
                </td>
                <td className="whitespace-nowrap text-ink-3">{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
