type CryptoSource = {
  randomUUID?: () => string;
  getRandomValues?: Crypto["getRandomValues"];
};

let fallbackId = 0;

export function createIdempotencyKey(cryptoApi: CryptoSource | undefined = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  fallbackId += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackId.toString(36)}`;
}

export class ApiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiHttpError";
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

// A late response from an old session must not sign out a newly logged-in user.
function checkUnauthorized(path: string, status: number, handler: typeof unauthorizedHandler) {
  if (status === 401 && handler === unauthorizedHandler && !path.startsWith("/api/auth/")) handler?.();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const handler = unauthorizedHandler;
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  checkUnauthorized(path, response.status, handler);
  const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiHttpError(payload?.error?.message ?? "请求失败", response.status, payload?.error?.code);
  return payload?.data as T;
}

// Each resource keeps its last unacknowledged action, independent of other cards.
export function createGenerationActions() {
  const pending = new Map<string, { signature: string; key: string }>();
  return async function submit<T>(resource: string, inputs: unknown, send: (key: string) => Promise<T>): Promise<T> {
    const signature = JSON.stringify(inputs);
    const previous = pending.get(resource);
    const key = previous && previous.signature === signature ? previous.key : createIdempotencyKey();
    pending.set(resource, { signature, key });
    const result = await send(key);
    if (pending.get(resource)?.key === key) pending.delete(resource);
    return result;
  };
}

type JsonOptions = Pick<RequestInit, "signal" | "headers"> & { idempotent?: boolean };

function jsonRequest<T>(method: string, path: string, body: unknown, options: JsonOptions = {}): Promise<T> {
  const { idempotent, headers: suppliedHeaders, signal } = options;
  const headers = new Headers(suppliedHeaders);
  if (body !== undefined || idempotent) headers.set("content-type", "application/json");
  if (idempotent && !headers.has("idempotency-key")) headers.set("idempotency-key", createIdempotencyKey());
  return request<T>(path, { method, headers, body: JSON.stringify(body), signal });
}

export function getJson<T>(path: string, options?: JsonOptions) {
  return jsonRequest<T>("GET", path, undefined, options);
}

export function postJson<T>(path: string, body?: unknown, options?: JsonOptions) {
  return jsonRequest<T>("POST", path, body, options);
}

export function patchJson<T>(path: string, body: unknown, options?: JsonOptions) {
  return jsonRequest<T>("PATCH", path, body, options);
}

export function putJson<T>(path: string, body: unknown, options?: JsonOptions) {
  return jsonRequest<T>("PUT", path, body, options);
}

export function deleteJson<T>(path: string, options?: JsonOptions) {
  return jsonRequest<T>("DELETE", path, undefined, options);
}

export async function postGeneration<T>(path: string, payload: object, key = createIdempotencyKey()): Promise<T> {
  const result = await postJson<T>(path, payload, { headers: { "idempotency-key": key } });
  if (result == null) throw new Error("未收到生成任务编号，请重试");
  return result;
}

export function uploadWithProgress<T>(path: string, form: FormData, options: {
  idempotent?: boolean;
  onProgress?: (percent: number) => void;
} = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = unauthorizedHandler;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    if (options.idempotent) xhr.setRequestHeader("idempotency-key", createIdempotencyKey());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = () => reject(new Error("上传失败，请检查网络连接"));
    xhr.onload = () => {
      checkUnauthorized(path, xhr.status, handler);
      try {
        const payload = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && payload?.data != null) resolve(payload.data);
        else reject(new ApiHttpError(payload?.error?.message ?? "上传失败", xhr.status, payload?.error?.code));
      } catch {
        reject(new Error("上传响应无效"));
      }
    };
    xhr.send(form);
  });
}
