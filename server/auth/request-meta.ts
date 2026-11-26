export type RequestHeaders = Record<string, string | undefined>;
export type TrustProxy = "auto" | boolean;

export interface ConnectionMeta {
  remoteAddress?: string;
  encrypted?: boolean;
}

export function header(headers: RequestHeaders, name: string) {
  return headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function forwardedHttps(headers: RequestHeaders) {
  return header(headers, "x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "https";
}

export function trustProxyFromEnv(value = process.env.AUTH_TRUST_PROXY): TrustProxy {
  switch (value?.trim().toLowerCase()) {
    case "true": return true;
    case "false": return false;
    default: return "auto";
  }
}

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function authRequestMeta(headers: RequestHeaders, { remoteAddress, encrypted }: ConnectionMeta, trustProxy: TrustProxy) {
  const trusted = trustProxy === true || (trustProxy === "auto" && loopback.has(remoteAddress ?? ""));
  const forwardedIp = trusted ? header(headers, "x-forwarded-for")?.split(",")[0].trim() : undefined;
  return {
    ipAddress: forwardedIp || remoteAddress,
    userAgent: header(headers, "user-agent"),
    isSecureRequest: Boolean(encrypted) || (trusted && forwardedHttps(headers)),
  };
}
