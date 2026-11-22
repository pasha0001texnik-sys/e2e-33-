"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  formatDuration,
  summarize,
  TERMINAL_RUN_STATUSES,
  type LogLevel,
  type Run,
  type RunLog,
  type RunStep,
  type RunTest,
} from "@e2e/shared";
import { Badge, Button, buttonClass, ErrorNote, Mono, StatusBadge } from "@/components/ui";
import { fmtDate, runDuration, TRIGGER_LABEL } from "@/lib/format";
import { supabaseBrowser } from "@/lib/supabase/client";
import { cancelRun, requestHold, rerunFailed, respondHold, setPaused } from "../actions";

type RunFull = Run & {
  suite: { name: string; slug: string } | null;
  stand: { slug: string; name: string; env: string; base_url: string } | null;
};

interface Data {
  run: RunFull;
  tests: RunTest[];
  steps: RunStep[];
}

const art = (path: string, download = false) => `/api/artifacts?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export function RunLive({ initial, canOperate }: { initial: Data & { logs: RunLog[] }; canOperate: boolean }) {
  const runId = initial.run.id;
  const qc = useQueryClient();
  const [logs, setLogs] = useState<RunLog[]>(initial.logs);
  const [now, setNow] = useState(() => Date.now());

  const { data } = useQuery<Data>({
    queryKey: ["run", runId],
    initialData: { run: initial.run, tests: initial.tests, steps: initial.steps },
    queryFn: async () => {
      const sb = supabaseBrowser();
      const [run, tests, steps] = await Promise.all([
        sb.from("runs").select("*, suite:suites(name, slug), stand:stands(slug, name, env, base_url)").eq("id", runId).single(),
        sb.from("run_tests").select("*").eq("run_id", runId).order("created_at"),
        sb.from("run_steps").select("*").eq("run_id", runId).order("id"),
      ]);
      if (run.error) throw run.error;
      return { run: run.data as RunFull, tests: (tests.data ?? []) as RunTest[], steps: (steps.data ?? []) as RunStep[] };
    },
    // страховка на случай, если Realtime недоступен
    refetchInterval: (q) => (TERMINAL_RUN_STATUSES.includes(q.state.data?.run.status ?? "queued") ? false : 10_000),
  });

  const active = !TERMINAL_RUN_STATUSES.includes(data.run.status);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Realtime: статусы и шаги → перезапрос; лог → дописываем
  useEffect(() => {
    const sb = supabaseBrowser();
    let t: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      clearTimeout(t);
      t = setTimeout(() => void qc.invalidateQueries({ queryKey: ["run", runId] }), 250);
    };
    const ch = sb
      .channel(`run:${runId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `id=eq.${runId}` }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "run_tests", filter: `run_id=eq.${runId}` }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "run_steps", filter: `run_id=eq.${runId}` }, invalidate)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "run_logs", filter: `run_id=eq.${runId}` }, (p: { new: unknown }) => {
        setLogs((prev) => (prev.some((l) => l.id === (p.new as RunLog).id) ? prev : [...prev.slice(-1999), p.new as RunLog]));
      })
      .subscribe();
    return () => {
      clearTimeout(t);
      void sb.removeChannel(ch);
    };
  }, [qc, runId]);

  const { run, tests, steps } = data;
  const summary = TERMINAL_RUN_STATUSES.includes(run.status) && run.summary?.total ? run.summary : summarize(tests);
  const hasFailed = tests.some((t) => ["failed", "cancelled", "skipped"].includes(t.status));
  const onHold = tests.filter((t) => t.status === "on_hold");

  return (
    <div className="space-y-6">
      <Header run={run} now={now} canOperate={canOperate} active={active} hasFailed={hasFailed} />

      {run.error && <ErrorNote>{run.error}</ErrorNote>}
      {onHold.length > 0 && (
        <div className="rounded-lg border border-hold/40 bg-hold/10 px-4 py-3 text-sm text-hold">
          {onHold.length === 1 ? "Тест ждёт вашего решения" : `${onHold.length} теста ждут решения`} — manual_hold. Сессия на стенде удерживается.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Тестов" value={summary.total ?? 0} />
        <Stat label="Passed" value={summary.passed ?? 0} tone="text-ok" />
        <Stat label="Flaky" value={summary.flaky ?? 0} tone="text-warn" />
        <Stat label="Failed" value={summary.failed ?? 0} tone="text-bad" />
        <Stat label="Длительность" value={formatDuration(runDuration(run, now))} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink-2">Тесты</h2>
          {tests.length === 0 && <p className="text-sm text-ink-3">{run.status === "queued" ? "Прогон ждёт свободный воркер…" : "Нет тестов"}</p>}
          {tests.map((t) => (
            <TestCard key={t.id} test={t} steps={steps.filter((s) => s.run_test_id === t.id)} canOperate={canOperate} now={now} />
          ))}
        </section>
        <LogPanel logs={logs} tests={tests} live={active} />
      </div>
    </div>
  );
}

function Header({ run, now, canOperate, active, hasFailed }: { run: RunFull; now: number; canOperate: boolean; active: boolean; hasFailed: boolean }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      setErr(null);
      try {
        await fn();
      } catch (e) {
        // redirect() из server action — не ошибка
        if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
        setErr((e as Error).message);
      }
    });

  return (
    <div>
      <div className="mb-2 text-xs text-ink-3">
        <Link href="/runs" className="hover:text-ink">
          Прогоны
        </Link>{" "}
        / #{run.number}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{run.suite?.name ?? "Прогон"}</h1>
            <StatusBadge status={run.status} />
            {run.cancel_requested && active && <Badge tone="warn">отменяется…</Badge>}
            {run.pause_requested && run.status !== "paused" && active && <Badge tone="warn">ставится на паузу…</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
            <span>
              Стенд <Mono className="text-ink">{run.stand?.slug}</Mono>
            </span>
            <span>
              Сборка <Mono className="text-ink">{run.build_tag}</Mono>
            </span>
            <span>Запуск: {TRIGGER_LABEL[run.trigger]}</span>
            <span>Потоков: {run.parallelism}</span>
            <span>Создан {fmtDate(run.created_at)}</span>
            {run.parent_run_id && (
              <Link href={`/runs/${run.parent_run_id}`} className="text-info hover:underline">
                исходный прогон
              </Link>
            )}
          </div>
          <div className="mt-1 text-xs text-ink-3">
            trace_id <Mono>{run.trace_id}</Mono>
            {run.worker_id && (
              <>
                {" "}
                · воркер <Mono>{run.worker_id}</Mono>
              </>
            )}
            {active && run.heartbeat_at && <> · heartbeat {Math.max(0, Math.round((now - new Date(run.heartbeat_at).getTime()) / 1000))} с назад</>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canOperate && active && (
            <>
              <Button disabled={pending} onClick={() => act(() => setPaused(run.id, !run.pause_requested))}>
                {run.pause_requested ? "Продолжить" : "Пауза"}
              </Button>
              <Button
                variant="danger"
                disabled={pending || run.cancel_requested}
                onClick={() => confirm("Отменить прогон? Идущие тесты будут прерваны.") && act(() => cancelRun(run.id))}
              >
                Отменить
              </Button>
            </>
          )}
          {canOperate && !active && hasFailed && (
            <Button variant="primary" disabled={pending} onClick={() => act(() => rerunFailed(run.id))}>
              Перезапустить упавшие
            </Button>
          )}
          <a className={buttonClass("ghost")} href={`/api/runs/${run.id}/export?format=json`}>
            JSON
          </a>
          <a className={buttonClass("ghost")} href={`/api/runs/${run.id}/export?format=csv`}>
            CSV
          </a>
        </div>
      </div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function TestCard({ test, steps, canOperate, now }: { test: RunTest; steps: RunStep[]; canOperate: boolean; now: number }) {
  const [open, setOpen] = useState(test.status === "failed" || test.status === "on_hold" || test.status === "running");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      setErr(null);
      try {
        await fn();
      } catch (e) {
        setErr((e as Error).message);
      }
    });

  const attempts = useMemo(() => {
    const m = new Map<number, RunStep[]>();
    for (const s of steps) m.set(s.attempt, [...(m.get(s.attempt) ?? []), s]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [steps]);
  const holdShot = test.status === "on_hold" ? `${test.run_id}/${test.id}/a${test.attempt}/hold.png` : null;

  return (
    <div className={`rounded-lg border bg-panel ${test.status === "on_hold" ? "border-hold/50" : "border-line"}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <StatusBadge status={test.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{test.name}</div>
          <div className="font-mono text-xs text-ink-3">{test.scenario_key}</div>
        </div>
        <div className="text-right text-xs text-ink-3">
          {test.max_attempts > 1 && (
            <div>
              попытка {test.attempt}/{test.max_attempts}
            </div>
          )}
          <div className="tabular-nums">{formatDuration(test.duration_ms ?? (test.started_at && !test.finished_at ? now - new Date(test.started_at).getTime() : null))}</div>
        </div>
        <span className="text-ink-3">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {test.error && (
            <pre className="whitespace-pre-wrap rounded-md bg-bad/10 p-3 font-mono text-xs text-bad">
              {test.error_kind && <span className="mr-2 rounded bg-bad/20 px-1.5 py-0.5">{test.error_kind}</span>}
              {test.error}
            </pre>
          )}

          {test.status === "on_hold" && (
            <div className="rounded-md border border-hold/40 bg-hold/5 p-3">
              <div className="text-sm">
                Удержание на шаге <b>«{test.hold_step}»</b>
                {test.hold_until && <> · авто-abort через {formatDuration(Math.max(0, new Date(test.hold_until).getTime() - now))}</>}
              </div>
              {holdShot && (
                <a href={art(holdShot)} target="_blank" className="mt-2 block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={art(holdShot)} alt="Снимок на момент удержания" className="max-h-64 rounded border border-line" />
                </a>
              )}
              {canOperate && (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => respondHold(test.id, "continue"))}>
                    continue
                  </Button>
                  <Button size="sm" disabled={pending} onClick={() => act(() => respondHold(test.id, "fail"))}>
                    fail
                  </Button>
                  <Button size="sm" variant="danger" disabled={pending} onClick={() => act(() => respondHold(test.id, "abort"))}>
                    abort
                  </Button>
                </div>
              )}
            </div>
          )}

          {canOperate && test.status === "running" && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => requestHold(test.id, !test.hold_requested))}>
              {test.hold_requested ? "Отменить hold" : "⏸ Hold на следующем шаге"}
            </Button>
          )}
          {err && <p className="text-sm text-bad">{err}</p>}

          {attempts.map(([attempt, list]) => (
            <div key={attempt}>
              {attempts.length > 1 && <div className="mb-1 text-xs font-medium text-ink-3">Попытка {attempt}</div>}
              <ol className="space-y-1">
                {list.map((s) => (
                  <StepRow key={s.id} step={s} now={now} />
                ))}
              </ol>
            </div>
          ))}

          {test.trace_path && (
            <div className="flex flex-wrap gap-3 text-xs">
              <a className="text-info hover:underline" href={art(test.trace_path, true)}>
                Скачать трейс Playwright
              </a>
              <span className="text-ink-3">
                Откройте его в <Mono>npx playwright show-trace trace.zip</Mono> или на trace.playwright.dev (файл читается локально в браузере)
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step, now }: { step: RunStep; now: number }) {
  const [netOpen, setNetOpen] = useState(false);
  const dur = step.finished_at ? new Date(step.finished_at).getTime() - new Date(step.started_at).getTime() : now - new Date(step.started_at).getTime();
  const icon = { running: "◌", passed: "✓", failed: "✗", skipped: "–" }[step.status];
  const color = { running: "text-info", passed: "text-ok", failed: "text-bad", skipped: "text-ink-3" }[step.status];
  return (
    <li className="rounded-md px-2 py-1.5 hover:bg-panel-2">
      <div className="flex items-center gap-2 text-sm">
        <span className={`w-4 text-center ${color} ${step.status === "running" ? "live-dot" : ""}`}>{icon}</span>
        <span className="w-5 text-right font-mono text-xs text-ink-3">{step.idx}</span>
        <span className="min-w-0 flex-1 truncate">{step.name}</span>
        {step.network_errors.length > 0 && (
          <button onClick={() => setNetOpen(!netOpen)} className="text-xs text-warn hover:underline">
            сеть: {step.network_errors.length}
          </button>
        )}
        {step.screenshot_path && (
          <a href={art(step.screenshot_path)} target="_blank" className="text-xs text-info hover:underline">
            скрин
          </a>
        )}
        {step.dom_path && (
          <a href={art(step.dom_path, true)} className="text-xs text-info hover:underline">
            DOM
          </a>
        )}
        <span className="w-20 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink-3">{formatDuration(dur)}</span>
      </div>
      {step.error && <pre className="ml-11 mt-1 whitespace-pre-wrap font-mono text-xs text-bad">{step.error}</pre>}
      {netOpen && (
        <ul className="ml-11 mt-1 space-y-0.5 font-mono text-xs text-warn">
          {step.network_errors.map((n, i) => (
            <li key={i} className="truncate">
              {n.method} {n.status ?? n.failure} {n.url}
            </li>
          ))}
        </ul>
      )}
      {step.status === "failed" && step.screenshot_path && (
        <a href={art(step.screenshot_path)} target="_blank" className="ml-11 mt-2 block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={art(step.screenshot_path)} alt={`Скриншот шага ${step.idx}`} loading="lazy" className="max-h-56 rounded border border-line" />
        </a>
      )}
    </li>
  );
}

const LEVEL_COLOR: Record<LogLevel, string> = { debug: "text-ink-3", info: "text-ink-2", warn: "text-warn", error: "text-bad" };

function LogPanel({ logs, tests, live }: { logs: RunLog[]; tests: RunTest[]; live: boolean }) {
  const [level, setLevel] = useState<"all" | "warn">("all");
  const [testId, setTestId] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map(tests.map((t) => [t.id, t.scenario_key])), [tests]);

  const shown = logs.filter(
    (l) => (level === "all" || l.level === "warn" || l.level === "error") && (!testId || l.run_test_id === testId),
  );

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);

  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-line bg-panel xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          Лог {live && <span className="live-dot size-1.5 rounded-full bg-ok" />}
        </h2>
        <select value={testId} onChange={(e) => setTestId(e.target.value)} className="input h-7 w-auto py-0 text-xs">
          <option value="">все тесты</option>
          {tests.map((t) => (
            <option key={t.id} value={t.id}>
              {t.scenario_key}
            </option>
          ))}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value as "all" | "warn")} className="input h-7 w-auto py-0 text-xs">
          <option value="all">все уровни</option>
          <option value="warn">warn и error</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-ink-3">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> следить
        </label>
      </header>
      <div ref={box} className="min-h-64 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {shown.length === 0 && <div className="text-ink-3">Пока пусто</div>}
        {shown.map((l) => (
          <div key={l.id} className={`whitespace-pre-wrap ${LEVEL_COLOR[l.level]}`}>
            <span className="text-ink-3">{new Date(l.ts).toLocaleTimeString("ru-RU")}</span>{" "}
            {l.run_test_id && <span className="text-info/70">[{names.get(l.run_test_id) ?? "test"}]</span>} {l.message}
          </div>
        ))}
      </div>
    </section>
  );
}
