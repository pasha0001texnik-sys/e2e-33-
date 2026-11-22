import { ConfirmButton } from "@/components/ConfirmButton";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Empty, Field, Mono, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { fmtAgo, fmtDate } from "@/lib/format";
import { createSchedule, deleteSchedule, toggleSchedule } from "./actions";

export const metadata = { title: "Расписания" };

const OVERLAP = { skip: "пропустить", queue: "в очередь", cancel_previous: "отменить предыдущий" } as const;

export default async function SchedulesPage() {
  const { supabase, profile } = await requireUser();
  const canEdit = roleAtLeast(profile.role, "qa");
  const [{ data: schedules }, { data: suites }, { data: stands }] = await Promise.all([
    supabase.from("schedules").select("*, suite:suites(name), stand:stands(slug, quiet_hours)").order("created_at"),
    supabase.from("suites").select("id, name").order("name"),
    supabase.from("stands").select("id, slug").eq("is_active", true).order("slug"),
  ]);

  return (
    <>
      <PageHeader
        title="Расписания"
        subtitle="Плановые прогоны. В тихие часы стенда они ждут в очереди, а ручные и CI-прогоны идут без ограничений."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {!schedules?.length ? (
          <Empty>Расписаний нет</Empty>
        ) : (
          <div className="table-wrap self-start">
            <table className="table">
              <thead>
                <tr>
                  <th>Сюит</th>
                  <th>Стенд</th>
                  <th>Cron</th>
                  <th>Следующий</th>
                  <th>Перекрытие</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className={s.enabled ? "" : "opacity-50"}>
                    <td className="font-medium">{s.suite?.name}</td>
                    <td>
                      <Mono>{s.stand?.slug}</Mono>
                    </td>
                    <td>
                      <Mono>{s.cron}</Mono>
                      <div className="text-xs text-ink-3">
                        {s.timezone} · <Mono>{s.build_tag}</Mono>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {s.enabled ? (
                        <>
                          {fmtDate(s.next_fire_at)}
                          <div className="text-xs text-ink-3">{s.last_fired_at ? `был ${fmtAgo(s.last_fired_at)}` : "ещё не запускался"}</div>
                        </>
                      ) : (
                        <Badge>выключено</Badge>
                      )}
                    </td>
                    <td className="text-ink-2">{OVERLAP[s.overlap_policy as keyof typeof OVERLAP]}</td>
                    <td className="whitespace-nowrap text-right">
                      {canEdit && (
                        <span className="flex justify-end gap-3 text-xs">
                          <ConfirmButton action={toggleSchedule.bind(null, s.id, !s.enabled)} className="text-ink-2 hover:text-ink">
                            {s.enabled ? "выключить" : "включить"}
                          </ConfirmButton>
                          <ConfirmButton confirm="Удалить расписание?" action={deleteSchedule.bind(null, s.id)} className="text-ink-3 hover:text-bad">
                            удалить
                          </ConfirmButton>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && (
          <Card title="Новое расписание">
            <ActionForm action={createSchedule} resetOnSuccess className="space-y-4">
              <Field label="Сюит">
                <select name="suite_id" className="input" required>
                  {(suites ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Стенд">
                <select name="stand_id" className="input" required>
                  {(stands ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.slug}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cron" hint="0 3 * * * — каждый день в 03:00">
                  <input name="cron" className="input font-mono" defaultValue="0 3 * * *" required />
                </Field>
                <Field label="Часовой пояс">
                  <input name="timezone" className="input font-mono" defaultValue="Europe/Moscow" required />
                </Field>
                <Field label="build_tag">
                  <input name="build_tag" className="input font-mono" defaultValue="latest" required />
                </Field>
                <Field label="Потоки" hint="0 — как в сюите">
                  <input name="parallelism" type="number" min={0} max={50} defaultValue={0} className="input" />
                </Field>
              </div>
              <Field label="Если предыдущий прогон ещё идёт">
                <select name="overlap_policy" className="input" defaultValue="skip">
                  <option value="skip">пропустить запуск</option>
                  <option value="queue">поставить в очередь</option>
                  <option value="cancel_previous">отменить предыдущий</option>
                </select>
              </Field>
              <SubmitButton>Создать</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
