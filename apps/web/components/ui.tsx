import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  secondary: "border border-line bg-panel-2 text-ink hover:border-ink-3",
  ghost: "text-ink-2 hover:bg-panel-2 hover:text-ink",
  danger: "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
};

export function buttonClass(variant: Variant = "secondary", size: "sm" | "md" = "md") {
  return [
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
    VARIANTS[variant],
  ].join(" ");
}

export function Button({
  variant,
  size,
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}

export function LinkButton({
  variant,
  size,
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" }) {
  return <Link className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-sm text-ink-3">{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

const TONES = {
  ok: "bg-ok/12 text-ok ring-ok/25",
  warn: "bg-warn/12 text-warn ring-warn/25",
  bad: "bg-bad/12 text-bad ring-bad/25",
  info: "bg-info/12 text-info ring-info/25",
  hold: "bg-hold/12 text-hold ring-hold/25",
  muted: "bg-ink-3/10 text-ink-2 ring-ink-3/25",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = "muted", children, live }: { tone?: Tone; children: ReactNode; live?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {live && <span className="live-dot size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, { tone: Tone; label: string; live?: boolean }> = {
  queued: { tone: "muted", label: "в очереди" },
  running: { tone: "info", label: "идёт", live: true },
  paused: { tone: "warn", label: "пауза" },
  on_hold: { tone: "hold", label: "manual hold", live: true },
  passed: { tone: "ok", label: "passed" },
  flaky: { tone: "warn", label: "flaky" },
  failed: { tone: "bad", label: "failed" },
  error: { tone: "bad", label: "ошибка" },
  cancelled: { tone: "muted", label: "отменён" },
  skipped: { tone: "muted", label: "пропущен" },
  // фикстуры
  created: { tone: "info", label: "created" },
  verified: { tone: "ok", label: "verified" },
  in_use: { tone: "info", label: "in_use", live: true },
  cleanup_pending: { tone: "warn", label: "cleanup_pending" },
  cleaned: { tone: "muted", label: "cleaned" },
  orphaned: { tone: "bad", label: "orphaned" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "muted" as Tone, label: status };
  return (
    <Badge tone={s.tone} live={s.live}>
      {s.label}
    </Badge>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.8em] ${className}`}>{children}</span>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{children}</div>;
}
