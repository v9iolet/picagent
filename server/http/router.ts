import { fail } from "../api-errors.js";
import type { AppResponse } from "../api-response.js";
import { nonEmptyString } from "./validators.js";

type Headers = Record<string, string | undefined>;

export interface RouteContext {
  method: string;
  path: string;
  pathname: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  idempotencyKey: string | undefined;
}

type Handler = (context: RouteContext) => AppResponse | Promise<AppResponse>;
type Pattern = string | RegExp;

export function requireIdempotencyKey(handler: (context: RouteContext & { idempotencyKey: string }) => ReturnType<Handler>): Handler {
  return (context) => {
    const key = nonEmptyString(context.idempotencyKey);
    return key ? handler({ ...context, idempotencyKey: key }) : fail("MISSING_IDEMPOTENCY_KEY", 400);
  };
}

export function decodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function compilePattern(pattern: Pattern): RegExp {
  if (pattern instanceof RegExp) return new RegExp(pattern);
  const segments = pattern.split("/").map((segment) => {
    if (/^:[A-Za-z_]\w*$/.test(segment)) return `(?<${segment.slice(1)}>[^/]+)`;
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/")}$`);
}

// Named captures use their names. Positional captures on a regex route use "1", "2", etc.
function matchParams(pattern: RegExp, pathname: string): Record<string, string> | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(pathname);
  if (!match) return null;
  const captures = match.groups ?? Object.fromEntries(match.slice(1).map((value, i) => [i + 1, value]));
  const params: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(captures)) {
    if (value === undefined) continue;
    const decoded = decodeParam(value);
    if (decoded === null) return null;
    params[name] = decoded;
  }
  return params;
}

export function createRouter() {
  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  function route(method: string, pattern: Pattern, handler: Handler) {
    routes.push({ method: method.toUpperCase(), pattern: compilePattern(pattern), handler });
  }
  const register = (method: string) => (pattern: Pattern, handler: Handler) => route(method, pattern, handler);

  async function dispatch(method: string, path: string, { headers = {}, body }: { headers?: Headers; body?: unknown } = {}): Promise<AppResponse | null> {
    const queryStart = path.indexOf("?");
    const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
    const verb = method.toUpperCase();
    for (const entry of routes) {
      if (entry.method !== verb) continue;
      const params = matchParams(entry.pattern, pathname);
      if (!params) continue;
      const query = new URLSearchParams(queryStart === -1 ? "" : path.slice(queryStart + 1));
      const idempotencyKey = Object.entries(headers).find(([name]) => name.toLowerCase() === "idempotency-key")?.[1];
      return entry.handler({ method: verb, path, pathname, params, query, headers, body, idempotencyKey });
    }
    return null;
  }

  return { route, get: register("GET"), post: register("POST"), patch: register("PATCH"), put: register("PUT"), delete: register("DELETE"), dispatch };
}
