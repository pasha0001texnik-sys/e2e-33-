"use client";

import { useMemo, useState } from "react";
import { SCENARIO_CATALOG } from "@e2e/shared";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field } from "@/components/ui";
import { createRun } from "../actions";

interface SuiteOpt {
  id: string;
  name: string;
  slug: string;
  scenario_keys: string[];
  default_parallelism: number;
  max_retries: number;
}
interface StandOpt {
  id: string;
  slug: string;
  name: string;
  env: string;
  max_concurrency: number;
}

const ENV_HINT: Record<string, string> = { dev: "dev", qa: "qa", staging: "staging" };

export function NewRunForm({
  suites,
  stands,
  defaults,
}: {
  suites: SuiteOpt[];
  stands: StandOpt[];
  defaults: { suite?: string; stand?: string };
}) {
  const [suiteId, setSuiteId] = useState(defaults.suite ?? suites[0]?.id ?? "");
  const [standId, setStandId] = useState(defaults.stand ?? stands[0]?.id ?? "");
  const suite = suites.find((s) => s.id === suiteId);
  const stand = stands.find((s) => s.id === standId);
  const names = useMemo(() => new Map(SCENARIO_CATALOG.map((s) => [s.key, s.name])), []);
  const deps = useMemo(() => new Map(SCENARIO_CATALOG.map((s) => [s.key, s.dependsOn])), []);

  if (!suites.length || !stands.length) {
    return (
      <p className="text-sm text-ink-2">
        Нужен хотя бы один сюит и один активный стенд. Их добавляет администратор в разделах «Сюиты» и «Стенды».
      </p>
    );
  }

  return (
    <ActionForm action={createRun} className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card title="Что и где">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Сюит">
              <select name="suite_id" className="input" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Стенд" hint={stand && `Лимит стенда: ${stand.max_concurrency} поток(ов)`}>
              <select name="stand_id" className="input" value={standId} onChange={(e) => setStandId(e.target.value)}>
                {stands.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({ENV_HINT[s.env]})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Сборка (build_tag)" hint="«latest» — без проверки версии на стенде">
              <input name="build_tag" className="input font-mono" defaultValue="latest" required />
            </Field>
          </div>
        </Card>

        {suite && (
          <Card title={`Сценарии · ${suite.scenario_keys.length}`}>
            <input type="hidden" name="scenarios_shown" value="1" />
            <p className="mb-3 text-xs text-ink-3">Снимите галочки, чтобы прогнать только часть сюита.</p>
            <div key={suite.id} className="grid gap-2 sm:grid-cols-2">
              {suite.scenario_keys.map((k) => (
                <label key={k} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm hover:border-ink-3">
                  <input type="checkbox" name="only_scenarios" value={k} defaultChecked className="mt-0.5 accent-[var(--color-accent)]" />
                  <span>
                    <span className="block">{names.get(k) ?? k}</span>
                    <span className="font-mono text-xs text-ink-3">{k}</span>
                    {deps.get(k)?.length ? (
                      <span className="block text-xs text-ink-3">сначала выполнится {deps.get(k)!.join(", ")}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <Card title="Параметры">
          <div className="space-y-4" key={`${suiteId}-${standId}`}>
            <Field label="Параллельные потоки">
              <input
                name="parallelism"
                type="number"
                min={1}
                max={stand?.max_concurrency ?? 50}
                defaultValue={Math.min(suite?.default_parallelism ?? 1, stand?.max_concurrency ?? 1)}
                className="input"
              />
            </Field>
            <Field label="Повторы при сбое инфраструктуры" hint="Упавшие проверки не повторяются. Прошедший со 2-й попытки тест помечается flaky.">
              <input name="max_retries" type="number" min={0} max={5} defaultValue={suite?.max_retries ?? 1} className="input" />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="hold_on_failure" className="mt-1 accent-[var(--color-accent)]" />
              <span>
                manual_hold при падении
                <span className="block text-xs text-ink-3">Воркер удержит сессию на упавшем шаге до вашего решения</span>
              </span>
            </label>
          </div>
        </Card>
        <SubmitButton pendingText="Ставлю в очередь…">Запустить прогон</SubmitButton>
      </div>
    </ActionForm>
  );
}
