import { notFound } from "next/navigation";
import type { Stand } from "@e2e/shared";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field, LinkButton, Mono, PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import { deleteSecret, saveStand, setSecret } from "../actions";

const DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

const FLAGS_EXAMPLE = `{
  "paths": { "signup": "/signup", "login": "/login", "onboarding": "/onboarding" },
  "selectors": { "login.submit": "button[type=submit]" },
  "password_policy": { "minLength": 12, "symbols": true },
  "mail_provider": "mailpit",
  "keep_fixtures": false
}`;

const CAPS_EXAMPLE = `{
  "appium:deviceName": "emulator-5554",
  "appium:app": "/apps/app-qa.apk",
  "appium:appPackage": "com.example.app"
}`;

const MOCKS_EXAMPLE = `{
  "routes": [
    { "url": "**/api/sms/send", "method": "POST", "json": { "ok": true } }
  ]
}`;

export default async function StandPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const { supabase, profile } = await requireUser();
  const isAdmin = roleAtLeast(profile.role, "admin");
  const isNew = id === "new";

  let stand: Partial<Stand> = { env: "qa", platform: "web", capabilities: {}, max_concurrency: 2, max_holds: 1, fixture_ttl_minutes: 120, is_active: true, mocks: {}, test_flags: {} };
  if (!isNew) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const { data } = await supabase.from("stands").select("*").eq("id", id).single();
    if (!data) notFound();
    stand = data as Stand;
  }
  const { data: secrets } = isAdmin && !isNew
    ? await supabase.from("stand_secrets").select("name, updated_at").eq("stand_id", id).order("name")
    : { data: [] as { name: string; updated_at: string }[] };

  const q = stand.quiet_hours;
  const json = (v: unknown) => (v && Object.keys(v as object).length ? JSON.stringify(v, null, 2) : "");

  return (
    <>
      <PageHeader
        title={isNew ? "Новый стенд" : stand.name}
        subtitle={!isNew && <Mono>{stand.base_url}</Mono>}
        actions={!isNew && <LinkButton href={`/runs/new?stand=${id}`}>Запустить прогон</LinkButton>}
      />
      {saved && <p className="mb-4 text-sm text-ok">Сохранено</p>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ActionForm action={saveStand} className="space-y-6">
          <fieldset disabled={!isAdmin} className="space-y-6">
            <input type="hidden" name="id" value={isNew ? "" : id} />
            <Card title="Основное">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Название">
                  <input name="name" className="input" defaultValue={stand.name} required />
                </Field>
                <Field label="Slug" hint="Используется в вебхуке CI">
                  <input name="slug" className="input font-mono" defaultValue={stand.slug} required />
                </Field>
                <Field label="Окружение" hint="production выбрать нельзя">
                  <select name="env" className="input" defaultValue={stand.env}>
                    <option value="dev">dev</option>
                    <option value="qa">qa</option>
                    <option value="staging">staging</option>
                  </select>
                </Field>
                <Field label="Базовый URL">
                  <input name="base_url" className="input font-mono" defaultValue={stand.base_url} placeholder="https://qa.example.test" required />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Allowlist хостов" hint="По одному в строке. *.domain — все поддомены. Всё остальное воркер блокирует в браузере.">
                    <textarea
                      name="allowed_hosts"
                      rows={3}
                      className="input font-mono"
                      defaultValue={(stand.allowed_hosts ?? []).join("\n")}
                      placeholder={"qa.example.test\n*.qa.example.test"}
                      required
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="is_active" defaultChecked={stand.is_active} /> Стенд активен
                </label>
              </div>
            </Card>

            <Card title="Платформа">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Тип стенда" hint="web — Playwright в Chrome; android / ios — Appium на эмуляторе или устройстве">
                  <select name="platform" className="input" defaultValue={stand.platform}>
                    <option value="web">web</option>
                    <option value="android">android</option>
                    <option value="ios">ios</option>
                  </select>
                </Field>
                <Field label="Appium-сервер" hint="Только для android / ios, например http://appium:4723">
                  <input name="appium_url" className="input font-mono" defaultValue={stand.appium_url ?? ""} placeholder="http://appium:4723" />
                </Field>
                <div className="sm:col-span-2">
                  <Field
                    label="Capabilities (JSON)"
                    hint="Сборка приложения под тестовый контур и устройство. Трафик нативного приложения воркер не перехватывает — защиту дают сборка и маркер /health."
                  >
                    <textarea
                      name="capabilities"
                      rows={5}
                      className="input font-mono text-xs"
                      defaultValue={json(stand.capabilities)}
                      placeholder={CAPS_EXAMPLE}
                    />
                  </Field>
                </div>
              </div>
            </Card>

            <Card title="Проверка окружения">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Health URL" hint='Ответ: {"env":"qa","build_tag":"v1.2.3"} или текст'>
                  <input name="health_url" className="input font-mono" defaultValue={stand.health_url ?? ""} />
                </Field>
                <Field label="Ожидаемый маркер окружения" hint="Прогон не стартует, если стенд вернёт другой">
                  <input name="expected_env_marker" className="input font-mono" defaultValue={stand.expected_env_marker ?? ""} placeholder="qa" />
                </Field>
              </div>
            </Card>

            <Card title="Почта и очистка">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Тестовый почтовый домен" hint="Алиасы вида e2e+run-1@домен">
                  <input name="mail_domain" className="input font-mono" defaultValue={stand.mail_domain ?? ""} placeholder="mail.qa.example.test" />
                </Field>
                <Field label="API перехватчика почты" hint="Mailpit / MailHog внутри тестового контура">
                  <input name="mailbox_api_url" className="input font-mono" defaultValue={stand.mailbox_api_url ?? ""} />
                </Field>
                <Field label="Cleanup API стенда" hint="POST {fixture_id, kind, email, run_id}, Bearer cleanup_token">
                  <input name="cleanup_api_url" className="input font-mono" defaultValue={stand.cleanup_api_url ?? ""} />
                </Field>
                <Field label="TTL фикстур, мин">
                  <input name="fixture_ttl_minutes" type="number" min={5} max={10080} className="input" defaultValue={stand.fixture_ttl_minutes} />
                </Field>
              </div>
            </Card>

            <Card title="Нагрузка">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Макс. потоков" hint="Жёсткий лимит на все прогоны стенда">
                  <input name="max_concurrency" type="number" min={1} max={50} className="input" defaultValue={stand.max_concurrency} />
                </Field>
                <Field label="Макс. manual_hold">
                  <input name="max_holds" type="number" min={0} max={10} className="input" defaultValue={stand.max_holds} />
                </Field>
                <Field label="Лимит RPS браузера" hint="0 — без лимита">
                  <input name="rps_limit" type="number" min={0} className="input" defaultValue={stand.rps_limit ?? 0} />
                </Field>
              </div>
              <div className="mt-4">
                <span className="label">Тихие часы (плановые прогоны не стартуют)</span>
                <div className="flex flex-wrap items-center gap-2">
                  <input name="quiet_from" type="time" className="input w-32" defaultValue={q?.from ?? ""} />
                  <span className="text-ink-3">—</span>
                  <input name="quiet_to" type="time" className="input w-32" defaultValue={q?.to ?? ""} />
                  <input name="quiet_tz" className="input w-48 font-mono" defaultValue={q?.tz ?? "Europe/Moscow"} />
                  <div className="flex gap-1">
                    {DAYS.map((d, i) => (
                      <label key={d} className="flex items-center gap-1 rounded border border-line px-1.5 py-1 text-xs">
                        <input type="checkbox" name="quiet_days" value={i + 1} defaultChecked={q?.days ? q.days.includes(i + 1) : i < 5} />
                        {d}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Моки и флаги сценариев">
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Моки (JSON)" hint="Ответы-заглушки в браузере воркера">
                  <textarea name="mocks" rows={8} className="input font-mono text-xs" defaultValue={json(stand.mocks)} placeholder={MOCKS_EXAMPLE} />
                </Field>
                <Field label="Флаги (JSON)" hint="Пути, селекторы, политика паролей">
                  <textarea name="test_flags" rows={8} className="input font-mono text-xs" defaultValue={json(stand.test_flags)} placeholder={FLAGS_EXAMPLE} />
                </Field>
              </div>
            </Card>
          </fieldset>
          {isAdmin && <SubmitButton>{isNew ? "Создать стенд" : "Сохранить"}</SubmitButton>}
        </ActionForm>

        {!isNew && isAdmin && (
          <div className="space-y-6">
            <Card title="Секреты стенда">
              <p className="mb-3 text-xs text-ink-3">
                Хранятся в Supabase Vault. После сохранения значение не показывается. Воркер использует{" "}
                <Mono>cleanup_token</Mono> и <Mono>mailbox_token</Mono>.
              </p>
              <ul className="mb-4 space-y-1.5">
                {(secrets ?? []).map((s) => (
                  <li key={s.name} className="flex items-center justify-between rounded-md bg-panel-2 px-3 py-2 text-sm">
                    <span>
                      <Mono>{s.name}</Mono> <span className="ml-1 text-ink-3">••••••</span>
                      <span className="block text-xs text-ink-3">изменён {fmtDate(s.updated_at)}</span>
                    </span>
                    <ConfirmButton confirm={`Удалить секрет ${s.name}?`} action={deleteSecret.bind(null, id, s.name)} className="text-xs text-ink-3 hover:text-bad">
                      удалить
                    </ConfirmButton>
                  </li>
                ))}
                {!secrets?.length && <li className="text-sm text-ink-3">Секретов нет</li>}
              </ul>
              <ActionForm action={setSecret} resetOnSuccess className="space-y-2">
                <input type="hidden" name="stand_id" value={id} />
                <input name="name" placeholder="cleanup_token" className="input font-mono" required />
                <input name="value" type="password" placeholder="значение" autoComplete="off" className="input" required />
                <SubmitButton variant="secondary">Сохранить секрет</SubmitButton>
              </ActionForm>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
