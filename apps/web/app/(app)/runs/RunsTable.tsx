"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatDuration, type RunStatus, type RunSummary } from "@e2e/shared";
import { Empty, Mono, StatusBadge } from "@/components/ui";
import { fmtAgo, runDuration, TRIGGER_LABEL } from "@/lib/format";

export interface RunRow {
  id: string;
  number: number;
  status: RunStatus;
  trigger: string;
  build_tag: string;
  parallelism: number;
  summary: RunSummary;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  suite: { name: string; slug: string } | null;
  stand: { slug: string; name: string; env: string } | null;
}

const col = createColumnHelper<RunRow>();

function Progress({ s }: { s: RunSummary }) {
  const total = s.total ?? 0;
  if (!total) return <span className="text-ink-3">—</span>;
  const seg = (n: number | undefined, cls: string) =>
    n ? <div className={cls} style={{ width: `${(n / total) * 100}%` }} /> : null;
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-line">
        {seg(s.passed, "bg-ok")}
        {seg(s.flaky, "bg-warn")}
        {seg(s.failed, "bg-bad")}
        {seg((s.skipped ?? 0) + (s.cancelled ?? 0), "bg-ink-3")}
      </div>
      <span className="text-xs tabular-nums text-ink-2">
        {(s.passed ?? 0) + (s.flaky ?? 0)}/{total}
        {s.flaky ? <span className="text-warn"> · {s.flaky} flaky</span> : null}
      </span>
    </div>
  );
}

export function RunsTable({ rows }: { rows: RunRow[] }) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const columns = [
    col.accessor("number", {
      header: "#",
      cell: (c) => (
        <Link href={`/runs/${c.row.original.id}`} className="font-mono text-ink-2 hover:text-accent">
          {c.getValue()}
        </Link>
      ),
    }),
    col.accessor("status", { header: "Статус", cell: (c) => <StatusBadge status={c.getValue()} /> }),
    col.accessor((r) => r.suite?.name ?? "—", {
      id: "suite",
      header: "Сюит",
      cell: (c) => (
        <Link href={`/runs/${c.row.original.id}`} className="font-medium hover:text-accent">
          {c.getValue()}
        </Link>
      ),
    }),
    col.accessor((r) => r.stand?.slug ?? "—", { id: "stand", header: "Стенд", cell: (c) => <Mono>{c.getValue()}</Mono> }),
    col.accessor("build_tag", { header: "Сборка", cell: (c) => <Mono className="text-ink-2">{c.getValue()}</Mono> }),
    col.display({ id: "progress", header: "Результат", cell: (c) => <Progress s={c.row.original.summary} /> }),
    col.accessor((r) => runDuration(r, now) ?? -1, {
      id: "duration",
      header: "Длительность",
      cell: (c) => <span className="tabular-nums text-ink-2">{c.getValue() < 0 ? "—" : formatDuration(c.getValue())}</span>,
    }),
    col.accessor("trigger", { header: "Запуск", cell: (c) => <span className="text-ink-2">{TRIGGER_LABEL[c.getValue()] ?? c.getValue()}</span> }),
    col.accessor("created_at", {
      header: "Создан",
      cell: (c) => <span className="whitespace-nowrap text-ink-3">{fmtAgo(c.getValue(), now)}</span>,
    }),
  ];

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (!rows.length) return <Empty>Прогонов пока нет. Запустите первый — кнопка справа сверху.</Empty>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className={h.column.getCanSort() ? "cursor-pointer select-none hover:text-ink" : ""}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="cursor-pointer" onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) return;
              router.push(`/runs/${row.original.id}`);
            }}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
