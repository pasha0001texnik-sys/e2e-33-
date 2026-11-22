const dtf = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return dtf.format(new Date(iso));
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "—";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) return `через ${fmtSpan(-s)}`;
  if (s < 10) return "только что";
  return `${fmtSpan(s)} назад`;
}

function fmtSpan(s: number) {
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

export function runDuration(r: { started_at: string | null; finished_at: string | null }, now = Date.now()) {
  if (!r.started_at) return null;
  return (r.finished_at ? new Date(r.finished_at).getTime() : now) - new Date(r.started_at).getTime();
}

export const TRIGGER_LABEL: Record<string, string> = {
  manual: "вручную",
  schedule: "расписание",
  webhook: "CI",
  rerun: "перезапуск",
};

/** Превращает ошибку Supabase/исключение в понятный текст для формы. */
export function errText(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/row-level security|permission denied|42501/i.test(msg)) return "Недостаточно прав для этого действия";
  if (/duplicate key/i.test(msg)) return "Такая запись уже существует";
  return msg;
}
