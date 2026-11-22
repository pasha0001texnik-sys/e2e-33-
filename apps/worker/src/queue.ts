// Очерёдность тестов внутри прогона: тест стартует, когда все его зависимости прошли.
// Если зависимость упала — зависимый тест пропускается с понятной причиной.

import type { TestStatus } from "@e2e/shared";

const PASSED: TestStatus[] = ["passed", "flaky"];

export interface QueueItem {
  scenario_key: string;
  depends_on: string[];
}

export type NextAction<T> =
  | { kind: "run"; item: T }
  | { kind: "skip"; item: T; reason: string }
  | { kind: "wait" }
  | { kind: "done" };

export class DependencyQueue<T extends QueueItem> {
  private pending: T[];
  private results = new Map<string, TestStatus>();

  /** pending — тесты к выполнению в порядке зависимостей; done — уже завершённые (например, пропущенные заранее). */
  constructor(pending: T[], done: Iterable<[string, TestStatus]> = []) {
    this.pending = [...pending];
    for (const [k, s] of done) this.results.set(k, s);
  }

  complete(key: string, status: TestStatus) {
    this.results.set(key, status);
  }

  get remaining() {
    return this.pending.length;
  }

  /**
   * Следующее действие для свободного потока.
   * running — сколько тестов прогона выполняется прямо сейчас.
   */
  next(running: number, cancelled = false): NextAction<T> {
    if (!this.pending.length) return { kind: "done" };
    if (cancelled) return { kind: "run", item: this.pending.shift()! }; // вызывающий отметит его отменённым

    for (let i = 0; i < this.pending.length; i++) {
      const item = this.pending[i]!;
      const failed = item.depends_on.find((d) => this.results.has(d) && !PASSED.includes(this.results.get(d)!));
      if (failed) {
        this.pending.splice(i, 1);
        this.results.set(item.scenario_key, "skipped");
        return { kind: "skip", item, reason: `Зависимость «${failed}» не прошла (${this.results.get(failed)}) — тест пропущен` };
      }
      if (item.depends_on.every((d) => PASSED.includes(this.results.get(d)!))) {
        this.pending.splice(i, 1);
        return { kind: "run", item };
      }
    }
    if (running === 0) {
      // ничего не выполняется, а оставшиеся ждут — их зависимости недостижимы
      const item = this.pending.shift()!;
      this.results.set(item.scenario_key, "skipped");
      return { kind: "skip", item, reason: "Зависимости теста не выполнены" };
    }
    return { kind: "wait" };
  }
}
