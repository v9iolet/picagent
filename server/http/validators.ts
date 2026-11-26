export const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function normalizeUuid(value: unknown): string | null {
  const trimmed = nonEmptyString(value);
  return isUuid(trimmed) ? trimmed.toLowerCase() : null;
}

export function hasValidUuids(...values: unknown[]): boolean {
  return values.every(isUuid);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function paginationInteger(raw: string | null, fallback: number): number | null {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) ? parsed : null;
}

// Both pagination styles produce a limit/offset pair. Existing list endpoints can
// select their own style explicitly to keep ignoring unrelated query parameters.
export function parsePagination(
  query: URLSearchParams,
  { mode = query.has("limit") || query.has("offset") ? "offset" : "page", defaultLimit = 24 }:
    { mode?: "offset" | "page"; defaultLimit?: number } = {},
): { limit: number; offset: number } | null {
  const limit = paginationInteger(query.get(mode === "page" ? "pageSize" : "limit"), defaultLimit);
  if (limit === null || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  if (mode === "offset") {
    const offset = paginationInteger(query.get("offset"), 0);
    return offset === null ? null : { limit, offset };
  }
  const page = paginationInteger(query.get("page"), 1);
  if (page === null || page < 1) return null;
  const offset = (page - 1) * limit;
  return Number.isSafeInteger(offset) ? { limit, offset } : null;
}
