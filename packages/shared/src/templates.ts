// Шаблоны генерации тестовых данных и локали. Браузеробезопасно: только данные и типы,
// без node-зависимостей — используется и в веб-форме, и в воркере.

export const LOCALES = ["en-US", "ru-RU", "de-DE"] as const;
export type Locale = (typeof LOCALES)[number];

export type Gender = "male" | "female";

export const LOCALE_LABEL: Record<Locale, string> = {
  "en-US": "English (US)",
  "ru-RU": "Русский (RU)",
  "de-DE": "Deutsch (DE)",
};

/** Часовой пояс по умолчанию для браузерного контекста выбранной локали. */
export const LOCALE_TIMEZONE: Record<Locale, string> = {
  "en-US": "America/New_York",
  "ru-RU": "Europe/Moscow",
  "de-DE": "Europe/Berlin",
};

export interface PasswordPolicy {
  minLength?: number;
  upper?: boolean;
  lower?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

export interface FixtureTemplate {
  key: string;
  label: string;
  locale: Locale;
  min_age: number;
  max_age: number;
  /** "any" — пол выбирается случайно */
  gender: Gender | "any";
  password_policy: PasswordPolicy;
}

/** Параметры браузерного контекста Playwright, согласованные с локалью. */
export interface BrowserProfile {
  locale: Locale;
  timezone: string;
  user_agent: string;
  viewport: { width: number; height: number };
}

/** Сгенерированная личность для входных данных сценария. */
export interface GeneratedPerson {
  first_name: string;
  last_name: string;
  gender: Gender;
  /** YYYY-MM-DD */
  birth_date: string;
  locale: Locale;
  login: string;
  email: string;
  password: string;
}

/** Каталог шаблонов. Ключ хранится в runs.fixture_template. */
export const FIXTURE_TEMPLATES: FixtureTemplate[] = [
  {
    key: "default",
    label: "По умолчанию (ru-RU, 18–65)",
    locale: "ru-RU",
    min_age: 18,
    max_age: 65,
    gender: "any",
    password_policy: { minLength: 14, upper: true, lower: true, digits: true, symbols: true },
  },
  {
    key: "us-adult",
    label: "US, взрослые (en-US, 21–70)",
    locale: "en-US",
    min_age: 21,
    max_age: 70,
    gender: "any",
    password_policy: { minLength: 12, upper: true, lower: true, digits: true, symbols: true },
  },
  {
    key: "de-adult",
    label: "DE, взрослые (de-DE, 18–60)",
    locale: "de-DE",
    min_age: 18,
    max_age: 60,
    gender: "any",
    password_policy: { minLength: 12, upper: true, lower: true, digits: true, symbols: false },
  },
  {
    key: "us-young",
    label: "US, молодёжь (en-US, 18–25)",
    locale: "en-US",
    min_age: 18,
    max_age: 25,
    gender: "any",
    password_policy: { minLength: 10, upper: true, lower: true, digits: true, symbols: false },
  },
];

export const DEFAULT_TEMPLATE = "default";

export function getTemplate(key: string | null | undefined): FixtureTemplate {
  return FIXTURE_TEMPLATES.find((t) => t.key === key) ?? FIXTURE_TEMPLATES.find((t) => t.key === DEFAULT_TEMPLATE)!;
}
