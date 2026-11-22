import type { Fixture, Run, Stand } from "@e2e/shared";
import { syntheticUser, type PasswordPolicy } from "@e2e/shared/node";
import { must, type Db } from "./db.ts";
import type { RunLogger } from "./logger.ts";

export interface UserFixture {
  id: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  locale: string;
}

/** Фикстуры конкретного теста: генерация, регистрация в реестре, захват готовых записей. */
export class FixtureService {
  private n = 0;

  constructor(
    private db: Db,
    private stand: Stand,
    private run: Run,
    private testId: string,
    private log: RunLogger,
    /** id фикстур, взятых из реестра (не созданных этим тестом) — общий для всех попыток */
    private claimed: string[] = [],
  ) {}

  private ttl(): string {
    return new Date(Date.now() + this.stand.fixture_ttl_minutes * 60_000).toISOString();
  }

  /** Новый синтетический пользователь. В реестр попадает до того, как появится на стенде. */
  async createUser(opts: { locale?: string; passwordPolicy?: PasswordPolicy } = {}): Promise<UserFixture> {
    if (!this.stand.mail_domain) throw new Error(`У стенда ${this.stand.slug} не задан mail_domain`);
    const policy = opts.passwordPolicy ?? (this.stand.test_flags as { password_policy?: PasswordPolicy }).password_policy;
    const u = syntheticUser({
      runId: this.run.id,
      n: ++this.n,
      mailDomain: this.stand.mail_domain,
      locale: opts.locale,
      passwordPolicy: policy,
    });
    this.log.addSecret(u.password);
    const row = must(
      await this.db
        .from("fixtures")
        .insert({
          stand_id: this.stand.id,
          run_id: this.run.id,
          run_test_id: this.testId,
          build_tag: this.run.build_tag,
          kind: "user",
          payload: { email: u.email, first_name: u.first_name, last_name: u.last_name, locale: u.locale },
          secret_payload: { password: u.password },
          status: "in_use",
          locked_by: this.testId,
          expires_at: this.ttl(),
        })
        .select("id")
        .single(),
      "fixture insert",
    ) as { id: string };
    this.log.for(this.testId).info(`Фикстура создана: ${u.email}`, { fixture_id: row.id });
    return { id: row.id, ...u };
  }

  async markVerified(id: string) {
    await this.db.from("fixtures").update({ status: "verified" }).eq("id", id);
  }

  async markFailed(id: string, error: string) {
    await this.db.from("fixtures").update({ status: "failed", last_error: error.slice(0, 2000) }).eq("id", id);
  }

  /** Захватывает готового (verified) пользователя на стенде атомарно; null, если свободных нет. */
  async claimUser(): Promise<UserFixture | null> {
    const res = await this.db.rpc("worker_claim_fixture", { p_stand: this.stand.id, p_kind: "user", p_test: this.testId });
    const fx = res.data as Fixture | null;
    if (res.error || !fx?.id) return null;
    this.claimed.push(fx.id);
    const secret = must(
      await this.db.from("fixtures").select("secret_payload").eq("id", fx.id).single(),
      "fixture secret",
    ) as { secret_payload: { password: string } };
    this.log.addSecret(secret.secret_payload.password);
    return {
      id: fx.id,
      email: String(fx.payload.email),
      password: secret.secret_payload.password,
      first_name: String(fx.payload.first_name ?? ""),
      last_name: String(fx.payload.last_name ?? ""),
      locale: String(fx.payload.locale ?? "ru"),
    };
  }
}
