import { getJson, postJson } from "./http.js";

export interface ApiAuthUser {
  id: string;
  username: string;
  role: "admin";
}

export interface ApiAuthSession {
  authEnabled: boolean;
  authenticated: boolean;
  user: ApiAuthUser | null;
  expiresAt?: string;
}

export interface ApiCaptchaChallenge {
  captchaId: string;
  imageDataUrl: string;
  expiresAt: string;
  ttlSeconds: number;
}

export interface ApiLoginInput {
  username: string;
  password: string;
  captchaId: string;
  captchaCode: string;
}

export interface ApiLoginResult {
  authenticated: true;
  user: ApiAuthUser;
  expiresAt: string;
}

export const authApi = {
  getSession: () => getJson<ApiAuthSession>("/api/auth/session"),
  getCaptcha: () => getJson<ApiCaptchaChallenge>("/api/auth/captcha"),
  login: (input: ApiLoginInput) => postJson<ApiLoginResult>("/api/auth/login", input),
  logout: () => postJson<{ ok: boolean }>("/api/auth/logout"),
};
