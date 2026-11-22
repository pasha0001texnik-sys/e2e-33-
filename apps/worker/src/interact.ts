// Взаимодействие с элементами с учётом таймингов шагов: плавный скролл,
// паузы до/после, ввод текста с задержкой между клавишами.
// При нулевых таймингах (профиль instant) поведение тождественно обычным fill/click.

import { pickKeystrokeDelay, type StepTimings } from "@e2e/shared";
import type { Locator } from "@playwright/test";

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class Interactor {
  constructor(private t: StepTimings) {}

  private async approach(loc: Locator) {
    if (this.t.smooth_scroll) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })).catch(() => {});
    }
    await sleep(this.t.pause_before_ms);
  }

  /** Ввод текста: с задержкой между клавишами, если задана; иначе обычный fill. */
  async fill(loc: Locator, text: string) {
    await this.approach(loc);
    const delay = pickKeystrokeDelay(this.t);
    if (delay > 0) {
      await loc.click();
      await loc.fill("");
      await loc.pressSequentially(text, { delay });
    } else {
      await loc.fill(text);
    }
    await sleep(this.t.pause_after_ms);
  }

  async click(loc: Locator) {
    await this.approach(loc);
    await loc.click();
    await sleep(this.t.pause_after_ms);
  }

  async check(loc: Locator) {
    await this.approach(loc);
    await loc.check();
    await sleep(this.t.pause_after_ms);
  }
}

// Мобильные взаимодействия (webdriverio): паузы до/после, ввод с задержкой между клавишами.
import type { ExecProfile } from "@e2e/shared";

export async function interactMobileFill(el: WebdriverIO.Element, text: string, profile: ExecProfile): Promise<void> {
  const t = profile.timings;
  await sleep(t.pause_before_ms);
  const delay = pickKeystrokeDelay(t);
  if (delay > 0) {
    await (el.clearValue?.() ?? Promise.resolve()).catch(() => {});
    for (const ch of text) {
      await el.addValue(ch);
      await sleep(delay);
    }
  } else {
    await el.setValue(text);
  }
  await sleep(t.pause_after_ms);
}

export async function interactMobileTap(el: WebdriverIO.Element, profile: ExecProfile): Promise<void> {
  await sleep(profile.timings.pause_before_ms);
  await el.click();
  await sleep(profile.timings.pause_after_ms);
}
