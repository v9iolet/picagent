import dns from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

const maxBytes = 32 * 1024 * 1024;
const globalUnicastV6 = ipaddr.IPv6.parseCIDR("2000::/3");
const invalidResponse = () => new Error("INVALID_PROVIDER_RESPONSE");

function isPublicAddress(address: string) {
  const ip = ipaddr.parse(address);
  return ip.range() === "unicast" && (ip.kind() === "ipv4" || ip.match(globalUnicastV6));
}

// Validate the answers used by the socket itself, so a second DNS lookup cannot change the destination.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, []);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return callback(invalidResponse(), []);
        const [first] = addresses;
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      });
    },
  },
});

function imageMimeType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  throw invalidResponse();
}

export async function downloadImageUrl(raw: string, signal: AbortSignal) {
  const url = URL.parse(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalidResponse();
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/(^|\.)(localhost|local)$/.test(host) || (isIP(host) && !isPublicAddress(host))) throw invalidResponse();

  const options = { signal, redirect: "error" as const, dispatcher };
  const response = await fetch(url, options).catch((error: unknown) => {
    if (error instanceof Error && error.cause instanceof Error && error.cause.message === "INVALID_PROVIDER_RESPONSE") throw invalidResponse();
    throw error;
  });
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw response.ok ? invalidResponse() : new Error("IMAGE_PROVIDER_FAILED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw invalidResponse();
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  const mimeType = imageMimeType(bytes);
  const declared = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== mimeType) throw invalidResponse();
  return { bytes, mimeType };
}
