// Профили выполнения прогона: тайминги шагов сценария и политика повторов.
// Браузеробезопасно (данные и типы) — используется в веб-форме и воркере.

import type { ErrorKind } from "./types.ts";

export interface StepTimings {
  /** Задержка между нажатиями клавиш при вводе текста, мс (0/0 — мгновенный fill) */
  keystroke_min_ms: number;
  keystroke_max_ms: number;
  /** Пауза перед взаимодействием с элементом, мс */
  pause_before_ms: number;
  /** Пауза после взаимодействия, мс */
  pause_after_ms: number;
  /** Плавная прокрутка к элементу перед кликом/вводом */
  smooth_scroll: boolean;
}

export interface RetryPolicy {
  /** Базовая задержка между попытками, мс (умножается на номер попытки) */
  base_delay_ms: number;
  /**
   * Какие ошибки шага повторяются. По умолчанию — только infra
   * (ограничение проекта: упавшая проверка не повторяется, иначе маскирует дефект).
   * Можно включить timeout; assertion оставляйте выключенным.
   */
  retry_on: ErrorKind[];
}

export interface ExecProfile {
  key: string;
  label: string;
  timings: StepTimings;
  retry: RetryPolicy;
}

const INSTANT_TIMINGS: StepTimings = {
  keystroke_min_ms: 0,
  keystroke_max_ms: 0,
  pause_before_ms: 0,
  pause_after_ms: 0,
  smooth_scroll: false,
};

/** Каталог профилей. Ключ хранится в runs.exec_profile. */
export const EXEC_PROFILES: ExecProfile[] = [
  {
    key: "instant",
    label: "Мгновенно (по умолчанию)",
    timings: INSTANT_TIMINGS,
    retry: { base_delay_ms: 2000, retry_on: ["infra"] },
  },
  {
    key: "human",
    label: "Человеческий ввод",
    timings: { keystroke_min_ms: 40, keystroke_max_ms: 120, pause_before_ms: 150, pause_after_ms: 100, smooth_scroll: true },
    retry: { base_delay_ms: 2000, retry_on: ["infra"] },
  },
  {
    key: "stable",
    label: "Стабильно (паузы + повтор таймаутов)",
    timings: { keystroke_min_ms: 10, keystroke_max_ms: 40, pause_before_ms: 300, pause_after_ms: 300, smooth_scroll: true },
    retry: { base_delay_ms: 3000, retry_on: ["infra", "timeout"] },
  },
];

export const DEFAULT_EXEC_PROFILE = "instant";

export function getExecProfile(key: string | null | undefined): ExecProfile {
  return EXEC_PROFILES.find((p) => p.key === key) ?? EXEC_PROFILES.find((p) => p.key === DEFAULT_EXEC_PROFILE)!;
}

/** Случайная задержка в [min, max] мс; 0 если оба нуля. */
export function pickKeystrokeDelay(t: StepTimings): number {
  if (t.keystroke_max_ms <= 0) return 0;
  const min = Math.max(0, Math.min(t.keystroke_min_ms, t.keystroke_max_ms));
  const max = Math.max(t.keystroke_min_ms, t.keystroke_max_ms);
  return min + Math.floor(Math.random() * (max - min + 1));
}
