// Чтение писем из перехватчика почты тестового контура (Mailpit или MailHog).
// Реальные почтовые ящики не используются.

import { GuardError, isRequestAllowed, type Stand } from "@e2e/shared";

export interface MailMessage {
  id: string;
  subject: string;
  to: string[];
  text: string;
  html: string;
  receivedAt: string;
}

export class Mailbox {
  private provider: "mailpit" | "mailhog";

  constructor(
    private stand: Stand,
    private token?: string,
    /** Заголовки трассировки прогона */
    private extraHeaders: Record<string, string> = {},
  ) {
    this.provider = (stand.test_flags as { mail_provider?: string }).mail_provider === "mailhog" ? "mailhog" : "mailpit";
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.stand.mailbox_api_url) throw new Error(`У стенда ${this.stand.slug} не настроен mailbox_api_url`);
    const url = new URL(path, this.stand.mailbox_api_url).toString();
    if (!isRequestAllowed(url, this.stand.allowed_hosts)) throw new GuardError(`Почтовый API вне allowlist: ${url}`);
    const res = await fetch(url, {
      headers: { ...this.extraHeaders, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      signal: AbortSignal.timeout(10000),
      redirect: "manual", // редирект мог бы увести за пределы allowlist
    });
    if (!res.ok) throw new Error(`Почтовый API ответил ${res.status} на ${path}`);
    return (await res.json()) as T;
  }

  private async search(to: string): Promise<MailMessage[]> {
    if (this.provider === "mailhog") {
      const r = await this.get<{ items: { ID: string; Created: string; Content: { Headers: Record<string, string[]>; Body: string } }[] }>(
        `/api/v2/search?kind=to&query=${encodeURIComponent(to)}`,
      );
      return r.items.map((m) => ({
        id: m.ID,
        subject: m.Content.Headers.Subject?.[0] ?? "",
        to: m.Content.Headers.To ?? [],
        text: m.Content.Body,
        html: m.Content.Body,
        receivedAt: m.Created,
      }));
    }
    const r = await this.get<{ messages: { ID: string; Subject: string; To: { Address: string }[]; Created: string }[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const out: MailMessage[] = [];
    for (const m of r.messages ?? []) {
      const full = await this.get<{ Text: string; HTML: string }>(`/api/v1/message/${m.ID}`);
      out.push({ id: m.ID, subject: m.Subject, to: m.To.map((t) => t.Address), text: full.Text, html: full.HTML, receivedAt: m.Created });
    }
    return out;
  }

  /** Ждёт письмо на адрес (опционально с фильтром по теме). */
  async waitForMessage(
    to: string,
    opts: { subjectIncludes?: string; timeoutMs?: number; after?: Date } = {},
  ): Promise<MailMessage> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60000);
    const after = opts.after?.getTime() ?? 0;
    while (Date.now() < deadline) {
      const msgs = (await this.search(to))
        .filter((m) => !opts.subjectIncludes || m.subject.toLowerCase().includes(opts.subjectIncludes.toLowerCase()))
        .filter((m) => new Date(m.receivedAt).getTime() >= after)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      if (msgs[0]) return msgs[0];
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Письмо на ${to}${opts.subjectIncludes ? ` с темой "${opts.subjectIncludes}"` : ""} не пришло`);
  }

  /** Код подтверждения: по умолчанию первые 4–8 цифр подряд. */
  static extractCode(msg: MailMessage, re = /\b(\d{4,8})\b/): string {
    const m = (msg.text || msg.html).match(re);
    if (!m) throw new Error("В письме не найден код подтверждения");
    return m[1] ?? m[0];
  }

  /** Ссылка из письма; ссылки вне allowlist стенда не возвращаются. */
  extractLink(msg: MailMessage, contains?: string): string {
    const links = [...(msg.html || msg.text).matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
    const link = links.find((l) => (!contains || l.includes(contains)) && isRequestAllowed(l, this.stand.allowed_hosts));
    if (!link) throw new Error(`В письме нет ссылки${contains ? ` с "${contains}"` : ""} на хосты стенда`);
    return link;
  }
}
