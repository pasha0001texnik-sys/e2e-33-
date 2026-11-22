// Генерация синтетических тестовых данных. Только для тестового контура:
// email всегда на тестовом домене стенда, никаких внешних почтовых сервисов.

import { randomBytes, randomInt } from "node:crypto";

export interface PasswordPolicy {
  minLength?: number;
  upper?: boolean;
  lower?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

const SETS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnopqrstuvwxyz",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+",
};

export function generatePassword(policy: PasswordPolicy = {}): string {
  const { minLength = 14, upper = true, lower = true, digits = true, symbols = true } = policy;
  const required: string[] = [];
  let pool = "";
  for (const [key, on] of Object.entries({ upper, lower, digits, symbols })) {
    if (!on) continue;
    const set = SETS[key as keyof typeof SETS];
    pool += set;
    required.push(set[randomInt(set.length)]!);
  }
  if (!pool) throw new Error("Политика пароля не допускает ни одного набора символов");
  const chars = [...required];
  while (chars.length < minLength) chars.push(pool[randomInt(pool.length)]!);
  // перемешивание Фишера — Йетса
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** Короткий префикс run_id для читаемых алиасов. */
export function shortRunId(runId: string): string {
  return runId.replace(/-/g, "").slice(0, 8);
}

/**
 * Алиас тестовой почты: e2e+{run}-{n}-{rand}@{mail_domain}.
 * Домен должен быть тестовым доменом стенда — проверяется вызывающим кодом через allowlist.
 */
export function emailAlias(runId: string, n: number, mailDomain: string): string {
  if (!mailDomain || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(mailDomain)) {
    throw new Error(`Невалидный mail_domain стенда: "${mailDomain}"`);
  }
  const rand = randomBytes(2).toString("hex");
  return `e2e+${shortRunId(runId)}-${n}-${rand}@${mailDomain.toLowerCase()}`;
}

const NAMES: Record<string, { first: string[]; last: string[] }> = {
  ru: { first: ["Анна", "Иван", "Мария", "Пётр", "Олег", "Елена"], last: ["Тестова", "Проверкин", "Сценарьева", "Стендов"] },
  en: { first: ["Alice", "Bob", "Carol", "Dave", "Erin"], last: ["Tester", "Fixture", "Sample", "Probe"] },
};

export interface SyntheticUser {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  locale: string;
}

export function syntheticUser(opts: {
  runId: string;
  n: number;
  mailDomain: string;
  locale?: string;
  passwordPolicy?: PasswordPolicy;
}): SyntheticUser {
  const locale = opts.locale ?? "ru";
  const names = NAMES[locale] ?? NAMES.en!;
  return {
    email: emailAlias(opts.runId, opts.n, opts.mailDomain),
    password: generatePassword(opts.passwordPolicy),
    first_name: names.first[randomInt(names.first.length)]!,
    last_name: names.last[randomInt(names.last.length)]!,
    locale,
  };
}
