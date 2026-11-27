import { randomUUID } from "node:crypto";
import type { AuthRepository, AuthSession, AuthUser, CaptchaConsumeResult, NewSession } from "../auth/types.js";

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser & { passwordHash: string }>();
  private readonly captchas = new Map<string, { codeHash: string; expiresAt: Date; usedAt: Date | null }>();
  private readonly sessions = new Map<string, AuthSession & { revokedAt: Date | null }>();

  async upsertAdminUser(username: string, passwordHash: string, options: { updateExistingPassword?: boolean } = {}) {
    const user = this.users.get(username);
    if (!user) this.users.set(username, { id: randomUUID(), username, role: "admin", passwordHash });
    else if (options.updateExistingPassword) user.passwordHash = passwordHash;
  }

  async findUserByUsername(username: string) {
    const user = this.users.get(username);
    return user ? { ...user } : null;
  }

  async createCaptcha(id: string, codeHash: string, expiresAt: Date) {
    if (this.captchas.has(id)) throw new Error("Duplicate captcha");
    this.captchas.set(id, { codeHash, expiresAt, usedAt: null });
  }

  async consumeCaptcha(captchaId: string, now: Date): Promise<CaptchaConsumeResult> {
    const captcha = this.captchas.get(captchaId);
    if (!captcha || captcha.usedAt) return { status: "missing_or_used" };
    if (captcha.expiresAt <= now) return { status: "expired" };
    captcha.usedAt = now;
    return { status: "ok", codeHash: captcha.codeHash };
  }

  async pruneExpiredCaptchas(before: Date) {
    for (const [id, captcha] of this.captchas) {
      if (captcha.expiresAt <= before) this.captchas.delete(id);
    }
  }

  async createSession({ userId, tokenHash, expiresAt, now }: NewSession) {
    const user = [...this.users.values()].find(({ id }) => id === userId);
    if (!user) throw new Error("Unknown session user");
    if (this.sessions.has(tokenHash)) throw new Error("Duplicate session token");
    this.sessions.set(tokenHash, {
      id: randomUUID(), user: { id: user.id, username: user.username, role: user.role },
      expiresAt, lastSeenAt: now, revokedAt: null,
    });
  }

  async findActiveSessionByTokenHash(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    return { id: session.id, user: { ...session.user }, expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt };
  }

  async revokeSessionByTokenHash(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = now;
  }

  async touchSession(sessionId: string, now: Date) {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId && session.lastSeenAt < now) session.lastSeenAt = now;
    }
  }
}
