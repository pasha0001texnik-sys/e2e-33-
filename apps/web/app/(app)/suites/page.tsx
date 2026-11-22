import { SCENARIO_CATALOG, type Suite } from "@e2e/shared";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Field, LinkButton, Mono, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { saveSuite } from "./actions";

export const metadata = { title: "Сюиты" };

export default async function SuitesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { supabase, profile } = await requireUser();
  const isAdmin = roleAtLeast(profile.role, "admin");
  const canRun = roleAtLeast(profile.role, "qa");
  const { edit } = await searchParams;
  const { data } = await supabase.from("suites").select("*").order("name");
  const suites = (data ?? []) as Suite[];
  const editing = suites.find((s) => s.id === edit);
  const names = new Map(SCENARIO_CATALOG.map((s) => [s.key, s.name]));
  const deps = new Map(SCENARIO_CATALOG.map((s) => [s.key, s.dependsOn]));

  return (
    <>
      <PageHeader title="Сюиты" subtitle="Наборы сценариев, которые запускаются вместе" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-3">
          {suites.map((s) => (
            <div key={s.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <Mono className="text-ink-3">{s.slug}</Mono>
                  </div>
                  {s.description && <p className="mt-1 text-sm text-ink-2">{s.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isAdmin && (
                    <LinkButton size="sm" variant="ghost" href={`/suites?edit=${s.id}`}>
                      Изменить
                    </LinkButton>
                  )}
                  {canRun && (
                    <LinkButton size="sm" href={`/runs/new?suite=${s.id}`}>
                      Запустить
                    </LinkButton>
                  )}
                </div>
              </div>
              <ol className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                {s.scenario_keys.map((k) => (
                  <li key={k} className="truncate text-ink-2">
                    <Mono className="text-ink-3">{k}</Mono> {names.get(k)}
                    {deps.get(k)?.length ? <span className="text-xs text-ink-3"> (после {deps.get(k)!.join(", ")})</span> : null}
                  </li>
                ))}
              </ol>
              <div className="mt-3 text-xs text-ink-3">
                {s.default_parallelism} поток(ов) · до {s.max_retries} повтор(ов) при сбое · таймаут теста {s.test_timeout_sec} с
              </div>
            </div>
          ))}
          {!suites.length && <p className="text-sm text-ink-3">Сюитов пока нет.</p>}
        </div>

        {isAdmin && (
          <Card
            title={editing ? `Изменить «${editing.name}»` : "Новый сюит"}
            actions={editing && <LinkButton size="sm" variant="ghost" href="/suites">Новый</LinkButton>}
          >
            <ActionForm key={editing?.id ?? "new"} action={saveSuite} resetOnSuccess={!editing} className="space-y-4">
              <input type="hidden" name="id" value={editing?.id ?? ""} />
              <Field label="Название">
                <input name="name" className="input" defaultValue={editing?.name} required />
              </Field>
              <Field label="Slug" hint="Для вебхука CI: suite">
                <input name="slug" className="input font-mono" defaultValue={editing?.slug} required />
              </Field>
              <Field label="Описание">
                <input name="description" className="input" defaultValue={editing?.description ?? ""} />
              </Field>
              <div>
                <span className="label">Сценарии</span>
                <div className="space-y-1.5">
                  {SCENARIO_CATALOG.map((sc) => (
                    <label key={sc.key} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="scenario_keys" value={sc.key} defaultChecked={editing?.scenario_keys.includes(sc.key)} className="mt-0.5" />
                      <span>
                        {sc.name} <Mono className="text-ink-3">{sc.key}</Mono>
                        <span className="block text-xs text-ink-3">
                          {sc.platforms.join(" · ")}
                          {sc.dependsOn.length > 0 && <> · сначала выполнится {sc.dependsOn.join(", ")}</>}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <Field label="Теги" hint="Через пробел или запятую">
                <input name="tags" className="input" defaultValue={editing?.tags.join(", ")} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Потоки">
                  <input name="default_parallelism" type="number" min={1} max={50} className="input" defaultValue={editing?.default_parallelism ?? 1} />
                </Field>
                <Field label="Повторы">
                  <input name="max_retries" type="number" min={0} max={5} className="input" defaultValue={editing?.max_retries ?? 1} />
                </Field>
                <Field label="Таймаут, с">
                  <input name="test_timeout_sec" type="number" min={10} max={3600} className="input" defaultValue={editing?.test_timeout_sec ?? 180} />
                </Field>
              </div>
              <SubmitButton>{editing ? "Сохранить" : "Создать"}</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
