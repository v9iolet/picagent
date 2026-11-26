import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { authErrorMessages } from "../errors/auth.js";
import { generateCaptchaCode, hashCaptchaCode, renderCaptchaSvg } from "./captcha.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { AuthRepository, AuthSessionSnapshot, AuthUser, CaptchaChallenge } from "./types.js";

const minute = 60_000;
const dummyPasswordHash = hashPassword(randomBytes(32).toString("hex"));
type Headers = Record<string, string | undefined>;

export interface AuthServiceOptions {
  adminUsername: string;
  adminPassword: string;
  syncAdminPassword: boolean;
  captchaTtlSeconds: number;
  sessionTtlHours: number;
  cookieName: string;
  cookieSecure: "auto" | boolean;
  maxLoginFailures: number;
  rateLimitWindowMs: number;
  now?: () => Date;
  generateCaptchaCode?: () => string;
}

function positiveInteger(raw: string | undefined, fallback: number) {
  const value = Number(raw?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function loadAuthServiceOptionsFromEnv(env = process.env): AuthServiceOptions {
  const password = env.AUTH_ADMIN_PASSWORD?.trim();
  const secure = env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  return {
    adminUsername: env.AUTH_ADMIN_USERNAME?.trim() || "admin",
    adminPassword: password || "woshisheng_666",
    syncAdminPassword: Boolean(password),
    captchaTtlSeconds: positiveInteger(env.AUTH_CAPTCHA_TTL_SECONDS, 180),
    sessionTtlHours: positiveInteger(env.AUTH_SESSION_TTL_HOURS, 168),
    cookieName: "picagent_session",
    cookieSecure: secure === "true" ? true : secure === "false" ? false : "auto",
    maxLoginFailures: 10,
    rateLimitWindowMs: 5 * minute,
  };
}

function header(headers: Headers, name: string) {
  return headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function isSecureRequest(headers: Headers): boolean {
  return header(headers, "x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "https";
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface LoginInput {
  username?: string;
  password?: string;
  captchaId?: string;
  captchaCode?: string;
  ipAddress?: string;
  userAgent?: string;
  isSecureRequest?: boolean;
}

export type LoginResult =
  | { ok: false; code: keyof typeof authErrorMessages; status: 400 | 401 | 429 }
  | { ok: true; user: AuthUser; expiresAt: string; setCookie: string };

export class AuthService {
  private readonly options: AuthServiceOptions;
  private readonly now: () => Date;
  private readonly failures = new Map<string, number[]>();
  private nextFailureCleanup = 0;

  constructor(private readonly repository: AuthRepository, options: Partial<AuthServiceOptions> = {}) {
    this.options = { ...loadAuthServiceOptionsFromEnv(), ...options };
    this.now = options.now ?? (() => new Date());
  }

  async ensureDefaultAdmin(): Promise<void> {
    const { adminUsername, adminPassword, syncAdminPassword } = this.options;
    await this.repository.upsertAdminUser(adminUsername, hashPassword(adminPassword), {
      updateExistingPassword: syncAdminPassword,
    });
  }

  async createCaptcha(): Promise<CaptchaChallenge> {
    const now = this.now();
    await this.repository.pruneExpiredCaptchas(new Date(now.getTime() - 10 * minute));
    const captchaId = randomUUID();
    const code = (this.options.generateCaptchaCode ?? generateCaptchaCode)();
    const imageDataUrl = renderCaptchaSvg(code);
    const ttlSeconds = this.options.captchaTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.repository.createCaptcha(captchaId, hashCaptchaCode(captchaId, code), expiresAt);
    return { captchaId, imageDataUrl, expiresAt: expiresAt.toISOString(), ttlSeconds };
  }

  private recentFailures(ip: string, now: number) {
    const cutoff = now - this.options.rateLimitWindowMs;
    if (now >= this.nextFailureCleanup) {
      for (const [key, entries] of this.failures) {
        if (entries.every((time) => time <= cutoff)) this.failures.delete(key);
      }
      this.nextFailureCleanup = now + this.options.rateLimitWindowMs;
    }
    return this.failures.get(ip)?.filter((time) => time > cutoff) ?? [];
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const username = typeof input.username === "string" ? input.username.trim() : "";
    if (!username || typeof input.password !== "string" || !input.password) {
      return { ok: false, code: "AUTH_FIELDS_REQUIRED", status: 400 };
    }
    if (typeof input.captchaId !== "string" || !input.captchaId.trim() ||
        typeof input.captchaCode !== "string" || !input.captchaCode.trim()) {
      return { ok: false, code: "CAPTCHA_REQUIRED", status: 400 };
    }
    const ip = input.ipAddress || "unknown";
    const now = this.now();
    if (this.recentFailures(ip, now.getTime()).length >= this.options.maxLoginFailures) {
      return { ok: false, code: "TOO_MANY_LOGIN_ATTEMPTS", status: 429 };
    }

    const challenge = await this.repository.consumeCaptcha(input.captchaId, now);
    if (challenge.status === "expired") return { ok: false, code: "CAPTCHA_EXPIRED", status: 400 };
    const expected = Buffer.from(hashCaptchaCode(input.captchaId, input.captchaCode), "hex");
    const stored = challenge.status === "ok" ? Buffer.from(challenge.codeHash, "hex") : null;
    if (!stored || stored.length !== expected.length || !timingSafeEqual(expected, stored)) {
      return { ok: false, code: "INVALID_CAPTCHA", status: 400 };
    }

    const account = await this.repository.findUserByUsername(username);
    // A parallel login may have recorded a failure while this request was waiting on storage.
    const checkedAt = this.now();
    const failures = this.recentFailures(ip, checkedAt.getTime());
    if (failures.length >= this.options.maxLoginFailures) {
      return { ok: false, code: "TOO_MANY_LOGIN_ATTEMPTS", status: 429 };
    }
    const validPassword = verifyPassword(input.password, account?.passwordHash ?? dummyPasswordHash);
    if (!validPassword || !account || account.username !== this.options.adminUsername) {
      this.failures.set(ip, [...failures, checkedAt.getTime()]);
      return { ok: false, code: "INVALID_CREDENTIALS", status: 401 };
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(checkedAt.getTime() + this.options.sessionTtlHours * 60 * minute);
    await this.repository.createSession({
      userId: account.id, tokenHash: hashToken(token), expiresAt, now: checkedAt,
      ipAddress: input.ipAddress, userAgent: input.userAgent,
    });
    this.failures.delete(ip);
    return {
      ok: true,
      user: { id: account.id, username: account.username, role: account.role },
      expiresAt: expiresAt.toISOString(),
      setCookie: this.buildSessionCookie(token, input.isSecureRequest ?? false),
    };
  }

  async authenticateHeaders(headers: Headers): Promise<AuthSessionSnapshot> {
    const token = this.parseSessionCookie(header(headers, "cookie"));
    if (!token) return { authenticated: false, user: null };
    const now = this.now();
    const session = await this.repository.findActiveSessionByTokenHash(hashToken(token), now);
    if (!session || session.user.username !== this.options.adminUsername) return { authenticated: false, user: null };
    if (now.getTime() - session.lastSeenAt.getTime() >= 5 * minute) {
      await this.repository.touchSession(session.id, now);
    }
    return { authenticated: true, user: session.user, expiresAt: session.expiresAt.toISOString(), sessionId: session.id };
  }

  async logout(headers: Headers, isSecureRequest = false): Promise<string> {
    const token = this.parseSessionCookie(header(headers, "cookie"));
    if (token) await this.repository.revokeSessionByTokenHash(hashToken(token), this.now());
    return this.buildClearCookie(isSecureRequest);
  }

  isSecureRequest(headers: Headers): boolean {
    return isSecureRequest(headers);
  }

  parseSessionCookie(cookie: string | undefined): string | null {
    const prefix = `${this.options.cookieName}=`;
    const value = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
    return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
  }

  private cookie(value: string, maxAge: number, secureRequest: boolean) {
    const secure = this.options.cookieSecure === "auto" ? secureRequest : this.options.cookieSecure;
    return `${this.options.cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  buildSessionCookie(token: string, secureRequest: boolean): string {
    return this.cookie(token, this.options.sessionTtlHours * 3600, secureRequest);
  }

  buildClearCookie(secureRequest: boolean): string {
    return this.cookie("", 0, secureRequest);
  }
}
