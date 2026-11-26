import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { authApi, type ApiAuthSession, type ApiLoginInput } from "../api/auth";
import { setUnauthorizedHandler } from "../api/http";

export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "/";
  const target = new URL(raw, "https://picagent.invalid");
  if (target.pathname.startsWith("//") || /^\/login(?:\/|$)/.test(target.pathname)) return "/";
  return raw;
}

const signedOut = { authenticated: false, user: null, expiresAt: undefined } as const;
interface AuthState extends ApiAuthSession {
  status: "loading" | "ready" | "error";
  notice: string | null;
}

interface AuthValue extends AuthState {
  retry: () => void;
  login: (input: ApiLoginInput) => Promise<void>;
  logout: () => Promise<void>;
}

const initialState: AuthState = { ...signedOut, authEnabled: true, status: "loading", notice: null };
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    authApi.getSession().then(session => {
      if (typeof session?.authEnabled !== "boolean" || typeof session.authenticated !== "boolean") {
        throw new Error("登录状态响应无效");
      }
      if (active) setState({ ...session, status: "ready", notice: null });
    }).catch(() => {
      if (active) setState({ ...initialState, status: "error" });
    });
    return () => { active = false; };
  }, [attempt]);

  useLayoutEffect(() => {
    if (!state.authEnabled || !state.authenticated) return;
    setUnauthorizedHandler(() => {
      setState(current => ({ ...current, ...signedOut, notice: "登录状态已失效，请重新登录" }));
    });
    return () => setUnauthorizedHandler(null);
  }, [state.authEnabled, state.authenticated]);

  function retry() {
    setState(initialState);
    setAttempt(value => value + 1);
  }

  async function login(input: ApiLoginInput) {
    const result = await authApi.login(input);
    setState({ ...result, authEnabled: true, status: "ready", notice: null });
  }

  async function logout() {
    await authApi.logout();
    setState(current => ({ ...current, ...signedOut, notice: null }));
  }

  return <AuthContext.Provider value={{ ...state, retry, login, logout }}>{children}</AuthContext.Provider>;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}

export function useAuth() {
  const auth = useOptionalAuth();
  if (!auth) throw new Error("useAuth requires AuthProvider");
  return auth;
}
