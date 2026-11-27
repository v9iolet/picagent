export interface AuthUser {
  id: string;
  username: string;
  role: "admin";
}

export interface AuthSession {
  id: string;
  user: AuthUser;
  expiresAt: Date;
  lastSeenAt: Date;
}

export type AuthSessionSnapshot =
  | { authenticated: false; user: null }
  | { authenticated: true; user: AuthUser; expiresAt: string; sessionId: string };

export interface CaptchaChallenge {
  captchaId: string;
  imageDataUrl: string;
  expiresAt: string;
  ttlSeconds: number;
}

export type CaptchaConsumeResult =
  | { status: "ok"; codeHash: string }
  | { status: "expired" }
  | { status: "missing_or_used" };

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  now: Date;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthRepository {
  upsertAdminUser(username: string, passwordHash: string, options?: { updateExistingPassword?: boolean }): Promise<void>;
  findUserByUsername(username: string): Promise<(AuthUser & { passwordHash: string }) | null>;
  createCaptcha(id: string, codeHash: string, expiresAt: Date): Promise<void>;
  consumeCaptcha(captchaId: string, now: Date): Promise<CaptchaConsumeResult>;
  pruneExpiredCaptchas(before: Date): Promise<void>;
  createSession(session: NewSession): Promise<void>;
  findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<AuthSession | null>;
  revokeSessionByTokenHash(tokenHash: string, now: Date): Promise<void>;
  touchSession(sessionId: string, now: Date): Promise<void>;
}
