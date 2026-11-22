import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

/** Загрузка артефактов в приватный бакет Supabase Storage. Возвращает путь или null. */
export class Artifacts {
  constructor(
    private db: Db,
    private cfg: Config,
  ) {}

  async upload(path: string, body: Buffer | string, contentType: string): Promise<string | null> {
    const { error } = await this.db.storage
      .from(this.cfg.ARTIFACTS_BUCKET)
      .upload(path, typeof body === "string" ? Buffer.from(body) : body, { contentType, upsert: true });
    if (error) {
      console.error(JSON.stringify({ level: "error", msg: "artifact upload failed", path, error: error.message }));
      return null;
    }
    return path;
  }

  static path(runId: string, testId: string, attempt: number, name: string) {
    return `${runId}/${testId}/a${attempt}/${name.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  }
}
