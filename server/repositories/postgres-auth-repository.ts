import type { QueryResult, QueryResultRow } from "pg";
import type { AuthRepository, AuthSession, AuthUser, CaptchaConsumeResult, NewSession } from "../auth/types.js";

interface Database {
  query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly db: Database) {}

  async upsertAdminUser(username: string, passwordHash: string, options: { updateExistingPassword?: boolean } = {}) {
    const onConflict = options.updateExistingPassword
      ? "DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()"
      : "DO NOTHING";
    await this.db.query(
      `INSERT INTO suite_workbench.auth_users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) ${onConflict}`, [username, passwordHash],
    );
  }

  async findUserByUsername(username: string) {
    const { rows } = await this.db.query<AuthUser & { passwordHash: string }>(
      `SELECT id, username, role, password_hash AS "passwordHash"
       FROM suite_workbench.auth_users WHERE username = $1`, [username],
    );
    return rows[0] ?? null;
  }

  async createCaptcha(id: string, codeHash: string, expiresAt: Date) {
    await this.db.query(
      "INSERT INTO suite_workbench.auth_captchas (id, code_hash, expires_at) VALUES ($1, $2, $3)",
      [id, codeHash, expiresAt],
    );
  }

  async consumeCaptcha(captchaId: string, now: Date): Promise<CaptchaConsumeResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(captchaId)) {
      return { status: "missing_or_used" };
    }
    const updated = await this.db.query<{ code_hash: string }>(
      `UPDATE suite_workbench.auth_captchas SET used_at = $2
       WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING code_hash`, [captchaId, now],
    );
    if (updated.rows.length) return { status: "ok", codeHash: updated.rows[0].code_hash };
    const { rows } = await this.db.query<{ expires_at: Date; used_at: Date | null }>(
      "SELECT expires_at, used_at FROM suite_workbench.auth_captchas WHERE id = $1", [captchaId],
    );
    const captcha = rows[0];
    if (captcha && captcha.used_at === null && captcha.expires_at <= now) return { status: "expired" };
    return { status: "missing_or_used" };
  }

  async pruneExpiredCaptchas(before: Date) {
    await this.db.query("DELETE FROM suite_workbench.auth_captchas WHERE expires_at <= $1", [before]);
  }

  async createSession({ userId, tokenHash, expiresAt, now, userAgent, ipAddress }: NewSession) {
    await this.db.query(
      `INSERT INTO suite_workbench.auth_sessions
       (user_id, token_hash, expires_at, created_at, last_seen_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $4, $5, $6)`, [userId, tokenHash, expiresAt, now, userAgent, ipAddress],
    );
  }

  async findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<AuthSession | null> {
    const { rows } = await this.db.query<{
      id: string; user_id: string; username: string; role: "admin"; expires_at: Date; last_seen_at: Date;
    }>(
      `SELECT s.id, s.user_id, u.username, u.role, s.expires_at, s.last_seen_at
       FROM suite_workbench.auth_sessions s JOIN suite_workbench.auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`, [tokenHash, now],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id, user: { id: row.user_id, username: row.username, role: row.role },
      expiresAt: row.expires_at, lastSeenAt: row.last_seen_at,
    };
  }

  async revokeSessionByTokenHash(tokenHash: string, now: Date) {
    await this.db.query(
      "UPDATE suite_workbench.auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash, now],
    );
  }

  async touchSession(sessionId: string, now: Date) {
    await this.db.query(
      "UPDATE suite_workbench.auth_sessions SET last_seen_at = $2 WHERE id = $1 AND last_seen_at < $2",
      [sessionId, now],
    );
  }
}
