"use client";

import { useMemo, useState } from "react";
import { EXEC_PROFILES, FIXTURE_TEMPLATES, getExecProfile, getNetProfile, getTemplate, LOCALE_LABEL, NET_PROFILES, SCENARIO_CATALOG } from "@e2e/shared";
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
  const [template, setTemplate] = useState(FIXTURE_TEMPLATES[0]!.key);
  const [execProfile, setExecProfile] = useState(EXEC_PROFILES[0]!.key);
  const [netProfile, setNetProfile] = useState(NET_PROFILES[0]!.key);
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
            <Field
              label="Шаблон тестовых данных"
              hint={`Локаль ${LOCALE_LABEL[getTemplate(template).locale]} · возраст ${getTemplate(template).min_age}–${getTemplate(template).max_age} · пароль от ${getTemplate(template).password_policy.minLength ?? 14} симв.`}
            >
              <select name="fixture_template" className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
                {FIXTURE_TEMPLATES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Профиль выполнения"
              hint={(() => {
                const p = getExecProfile(execProfile);
                const t = p.timings;
                const typing = t.keystroke_max_ms > 0 ? `ввод ${t.keystroke_min_ms}–${t.keystroke_max_ms} мс/клавишу` : "мгновенный ввод";
                const retry = `повтор: ${p.retry.retry_on.join(", ")} · задержка ${p.retry.base_delay_ms} мс`;
                return `${typing} · ${retry}`;
              })()}
            >
              <select name="exec_profile" className="input" value={execProfile} onChange={(e) => setExecProfile(e.target.value)}>
                {EXEC_PROFILES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Гео- и сетевая эмуляция"
              hint={(() => {
                const p = getNetProfile(netProfile);
                if (p.key === "none") return "Без эмуляции: как есть, по сети стенда";
                const parts: string[] = [];
                if (p.geo) parts.push(`гео ${p.geo.region ?? `${p.geo.latitude}, ${p.geo.longitude}`}`);
                if (p.network?.offline) parts.push("offline");
                else if (p.network?.download) parts.push(`${Math.round(p.network.download / 125)} кбит/с${p.network.latency ? ` · +${p.network.latency} мс` : ""}`);
                return parts.join(" · ") || "эмуляция в браузере воркера";
              })()}
            >
              <select name="net_profile" className="input" value={netProfile} onChange={(e) => setNetProfile(e.target.value)}>
                {NET_PROFILES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
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
