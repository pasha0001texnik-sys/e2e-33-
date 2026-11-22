// Генерация синтетических тестовых данных. Только для тестового контура:
// email всегда на тестовом домене стенда, никаких внешних почтовых сервисов.

import { randomBytes, randomInt } from "node:crypto";
import {
  getTemplate,
  LOCALE_TIMEZONE,
  type BrowserProfile,
  type FixtureTemplate,
  type GeneratedPerson,
  type Gender,
  type Locale,
  type PasswordPolicy,
} from "./templates.ts";

export type { PasswordPolicy } from "./templates.ts";

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

// ---------------------------------------------------------------------------
// Имена по локали и полу
// ---------------------------------------------------------------------------
interface NameSet {
  first: Record<Gender, string[]>;
  /** Фамилии; для ru различаются по полу (-ов / -ова) */
  last: Record<Gender, string[]>;
}

const NAMES: Record<Locale, NameSet> = {
  "ru-RU": {
    first: {
      male: ["Иван", "Пётр", "Олег", "Сергей", "Дмитрий", "Алексей"],
      female: ["Анна", "Мария", "Елена", "Ольга", "Татьяна", "Ирина"],
    },
    last: {
      male: ["Тестов", "Проверкин", "Сценарьев", "Стендов", "Фикстуров"],
      female: ["Тестова", "Проверкина", "Сценарьева", "Стендова", "Фикстурова"],
    },
  },
  "en-US": {
    first: {
      male: ["James", "Robert", "Michael", "David", "Daniel", "Chris"],
      female: ["Mary", "Alice", "Carol", "Erin", "Linda", "Susan"],
    },
    last: {
      male: ["Tester", "Fixture", "Sample", "Probe", "Walker", "Reed"],
      female: ["Tester", "Fixture", "Sample", "Probe", "Walker", "Reed"],
    },
  },
  "de-DE": {
    first: {
      male: ["Lukas", "Jonas", "Felix", "Paul", "Max", "Tim"],
      female: ["Anna", "Lena", "Marie", "Laura", "Julia", "Sophie"],
    },
    last: {
      male: ["Müller", "Schmidt", "Fischer", "Weber", "Wagner", "Becker"],
      female: ["Müller", "Schmidt", "Fischer", "Weber", "Wagner", "Becker"],
    },
  },
};

// Транслитерация для логина/email (кириллица и умляуты → ASCII)
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ä: "ae", ö: "oe", ü: "ue", ß: "ss",
};

function toAscii(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

function pick<T>(arr: T[]): T {
  return arr[randomInt(arr.length)]!;
}

/** Дата рождения YYYY-MM-DD для случайного возраста в [minAge, maxAge]. */
export function birthDateForAge(minAge: number, maxAge: number, now: Date = new Date()): string {
  if (minAge < 0 || maxAge < minAge) throw new Error(`Некорректный диапазон возраста: ${minAge}..${maxAge}`);
  const age = minAge + randomInt(maxAge - minAge + 1);
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - age);
  // случайный сдвиг в пределах года, но не в будущее
  d.setDate(d.getDate() - randomInt(365));
  return d.toISOString().slice(0, 10);
}

export interface GeneratePersonOptions {
  runId: string;
  n: number;
  mailDomain: string;
  template?: FixtureTemplate | string;
  /** Переопределения поверх шаблона */
  locale?: Locale;
  gender?: Gender;
  minAge?: number;
  maxAge?: number;
  passwordPolicy?: PasswordPolicy;
}

/** Полная сгенерированная личность: имя, фамилия, пол, дата рождения, логин, email, пароль. */
export function generatePerson(opts: GeneratePersonOptions): GeneratedPerson {
  const tpl = typeof opts.template === "object" ? opts.template : getTemplate(opts.template);
  const locale: Locale = opts.locale ?? tpl.locale;
  const gender: Gender = opts.gender ?? (tpl.gender === "any" ? pick<Gender>(["male", "female"]) : tpl.gender);
  const minAge = opts.minAge ?? tpl.min_age;
  const maxAge = opts.maxAge ?? tpl.max_age;
  const policy = opts.passwordPolicy ?? tpl.password_policy;

  const names = NAMES[locale];
  const first = pick(names.first[gender]);
  const last = pick(names.last[gender]);
  const birth_date = birthDateForAge(minAge, maxAge);
  const login = `${toAscii(first)}.${toAscii(last)}${100 + randomInt(900)}`;

  return {
    first_name: first,
    last_name: last,
    gender,
    birth_date,
    locale,
    login,
    email: emailAlias(opts.runId, opts.n, opts.mailDomain),
    password: generatePassword(policy),
  };
}

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
];

const VIEWPORTS: { width: number; height: number }[] = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
];

/** Параметры браузерного контекста, согласованные с локалью. */
export function browserProfile(locale: Locale): BrowserProfile {
  return {
    locale,
    timezone: LOCALE_TIMEZONE[locale],
    user_agent: pick(UA_POOL),
    viewport: pick(VIEWPORTS),
  };
}

// ---------------------------------------------------------------------------
// Обратная совместимость
// ---------------------------------------------------------------------------
export interface SyntheticUser {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  locale: string;
}

const LEGACY_LOCALE: Record<string, Locale> = { ru: "ru-RU", en: "en-US", de: "de-DE" };

export function syntheticUser(opts: {
  runId: string;
  n: number;
  mailDomain: string;
  locale?: string;
  passwordPolicy?: PasswordPolicy;
}): SyntheticUser {
  const locale = (LEGACY_LOCALE[opts.locale ?? ""] ?? (opts.locale as Locale)) || "ru-RU";
  const p = generatePerson({
    runId: opts.runId,
    n: opts.n,
    mailDomain: opts.mailDomain,
    locale: (["en-US", "ru-RU", "de-DE"] as string[]).includes(locale) ? locale : "ru-RU",
    passwordPolicy: opts.passwordPolicy,
  });
  // echo-ируем переданную локаль для обратной совместимости
  return { email: p.email, password: p.password, first_name: p.first_name, last_name: p.last_name, locale: opts.locale ?? "ru" };
}
