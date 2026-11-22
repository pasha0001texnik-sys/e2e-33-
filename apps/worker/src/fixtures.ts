import type { Fixture, FixtureTemplate, Gender, Run, Stand } from "@e2e/shared";
import { generatePerson, type PasswordPolicy } from "@e2e/shared/node";
import { must, type Db } from "./db.ts";
import type { RunLogger } from "./logger.ts";

export interface UserFixture {
  id: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  gender?: Gender;
  birth_date?: string;
  login?: string;
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
    /** Шаблон генерации тестовых данных прогона */
    private template?: FixtureTemplate,
  ) {}

  private ttl(): string {
    return new Date(Date.now() + this.stand.fixture_ttl_minutes * 60_000).toISOString();
  }

  /** Новый синтетический пользователь. В реестр попадает до того, как появится на стенде. */
  async createUser(opts: { locale?: never; passwordPolicy?: PasswordPolicy } = {}): Promise<UserFixture> {
    if (!this.stand.mail_domain) throw new Error(`У стенда ${this.stand.slug} не задан mail_domain`);
    const policy = opts.passwordPolicy ?? (this.stand.test_flags as { password_policy?: PasswordPolicy }).password_policy;
    const p = generatePerson({
      runId: this.run.id,
      n: ++this.n,
      mailDomain: this.stand.mail_domain,
      template: this.template,
      passwordPolicy: policy,
    });
    this.log.addSecret(p.password);
    const row = must(
      await this.db
        .from("fixtures")
        .insert({
          stand_id: this.stand.id,
          run_id: this.run.id,
          run_test_id: this.testId,
          build_tag: this.run.build_tag,
          kind: "user",
          // открытые поля — в payload; пароль — в защищённый secret_payload
          payload: {
            email: p.email,
            first_name: p.first_name,
            last_name: p.last_name,
            gender: p.gender,
            birth_date: p.birth_date,
            login: p.login,
            locale: p.locale,
          },
          secret_payload: { password: p.password },
          status: "in_use",
          locked_by: this.testId,
          expires_at: this.ttl(),
        })
        .select("id")
        .single(),
      "fixture insert",
    ) as { id: string };
    this.log.for(this.testId).info(`Фикстура создана: ${p.email}`, { fixture_id: row.id });
    return {
      id: row.id,
      email: p.email,
      password: p.password,
      first_name: p.first_name,
      last_name: p.last_name,
      gender: p.gender,
      birth_date: p.birth_date,
      login: p.login,
      locale: p.locale,
    };
  }

  async markVerified(id: string) {
    await this.db.from("fixtures").update({ status: "verified" }).eq("id", id);
  }

  async markFailed(id: string, error: string) {
    await this.db.from("fixtures").update({ status: "failed", last_error: error.slice(0, 2000) }).eq("id", id);
  }

  /**
   * Берёт фикстуру, которую передал тест-зависимость этого же прогона (по id).
   * null — если её уже занял другой тест или она не из этого прогона.
   */
  async adopt(fixtureId: string): Promise<UserFixture | null> {
    const res = await this.db.rpc("worker_claim_fixture_by_id", { p_fixture: fixtureId, p_run: this.run.id, p_test: this.testId });
    const fx = (Array.isArray(res.data) ? res.data[0] : res.data) as Fixture | null;
    if (res.error || !fx?.id) return null;
    this.claimed.push(fx.id);
    return this.toUser(fx);
  }

  private async toUser(fx: Fixture): Promise<UserFixture> {
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
      gender: fx.payload.gender as Gender | undefined,
      birth_date: fx.payload.birth_date as string | undefined,
      login: fx.payload.login as string | undefined,
      locale: String(fx.payload.locale ?? "ru-RU"),
    };
  }

  /** Захватывает готового (verified) пользователя на стенде атомарно; null, если свободных нет. */
  async claimUser(): Promise<UserFixture | null> {
    const res = await this.db.rpc("worker_claim_fixture", { p_stand: this.stand.id, p_kind: "user", p_test: this.testId });
    const fx = (Array.isArray(res.data) ? res.data[0] : res.data) as Fixture | null;
    if (res.error || !fx?.id) return null;
    this.claimed.push(fx.id);
    return this.toUser(fx);
  }

}
