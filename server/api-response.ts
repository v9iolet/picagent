import { randomUUID } from "node:crypto";
import type { ResponseEnvelope, ErrorEnvelope } from "./types.js";

export interface AppResponse {
  status: number;
  body: ResponseEnvelope<unknown> | ErrorEnvelope;
  headers?: Record<string, string>;
  raw?: Buffer;
}

export function ok<T>(data: T, status = 200): AppResponse {
  return { status, body: { data, requestId: randomUUID() } };
}

export const now = () => new Date().toISOString();

export function dataOf(response: AppResponse): unknown {
  return "data" in response.body ? response.body.data : null;
}

// Some legacy endpoints treat arrays as objects. Keep that distinction at the call site.
export function asRecord(value: unknown, { allowArrays = false } = {}): Record<string, unknown> {
  return value !== null && typeof value === "object" && (allowArrays || !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {};
}
