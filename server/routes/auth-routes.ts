import { fail } from "../api-errors.js";
import { asRecord, ok, type AppResponse } from "../api-response.js";
import type { AuthService } from "../auth/auth-service.js";
import { authRequestMeta, type ConnectionMeta, type RequestHeaders, type TrustProxy } from "../auth/request-meta.js";

type AuthHandler = (
  service: AuthService | undefined,
  options: ConnectionMeta & { body?: unknown; headers?: RequestHeaders },
  trustProxy: TrustProxy,
) => Promise<AppResponse>;

const session: AuthHandler = async (service, { headers = {} }) => {
  if (!service) return ok({ authEnabled: false, authenticated: true, user: null });
  const snapshot = await service.authenticateHeaders(headers);
  return ok({
    authEnabled: true, authenticated: snapshot.authenticated, user: snapshot.user,
    ...(snapshot.authenticated ? { expiresAt: snapshot.expiresAt } : {}),
  });
};

const login: AuthHandler = async (service, options, trustProxy) => {
  if (!service) return fail("NOT_FOUND", 404);
  const { username, password, captchaId, captchaCode } = asRecord(options.body);
  const result = await service.login({
    username: typeof username === "string" ? username : undefined,
    password: typeof password === "string" ? password : undefined,
    captchaId: typeof captchaId === "string" ? captchaId : undefined,
    captchaCode: typeof captchaCode === "string" ? captchaCode : undefined,
    ...authRequestMeta(options.headers ?? {}, options, trustProxy),
  });
  if (!result.ok) return fail(result.code, result.status);
  return { ...ok({ authenticated: true, user: result.user, expiresAt: result.expiresAt }), headers: { "set-cookie": result.setCookie } };
};

const logout: AuthHandler = async (service, options, trustProxy) => {
  const response = ok({ ok: true });
  if (!service) return response;
  const headers = options.headers ?? {};
  const { isSecureRequest } = authRequestMeta(headers, options, trustProxy);
  const clearCookie = await service.logout(headers, isSecureRequest);
  return { ...response, headers: { "set-cookie": clearCookie } };
};

const publicRoutes = new Map<string, AuthHandler>([
  ["GET /api/auth/session", session],
  ["GET /api/auth/captcha", async (service) => service ? ok(await service.createCaptcha()) : fail("NOT_FOUND", 404)],
  ["POST /api/auth/login", login],
  ["POST /api/auth/logout", logout],
]);

export function isAuthPathname(pathname: string): boolean {
  return /^\/api\/auth(?:\/|$)/i.test(pathname);
}

export function publicAuthRoute(method: string, pathname: string) {
  return publicRoutes.get(`${method.toUpperCase()} ${pathname}`);
}
