import dns from "node:dns";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

const maxBytes = 32 * 1024 * 1024;
const globalUnicastV6 = ipaddr.IPv6.parseCIDR("2000::/3");
const fakeIpRange = ipaddr.IPv4.parseCIDR("198.18.0.0/15");
const invalidResponse = () => new Error("INVALID_PROVIDER_RESPONSE");

function isPublicAddress(address: string) {
  const ip = ipaddr.parse(address);
  return ip.range() === "unicast" && (ip.kind() === "ipv4" || ip.match(globalUnicastV6));
}

function isFakeIp(address: string) {
  return isIP(address) === 4 && ipaddr.IPv4.parse(address).match(fakeIpRange);
}

function dnsServerAddress(server: string) {
  // Node accepts IPv4:port and [IPv6]:port, as well as bare addresses.
  return server.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1] ?? server.replace(/^(\d+(?:\.\d+){3}):\d+$/, "$1");
}

interface ImageUrlNetwork {
  dnsLookup: (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;
  getDnsServers: typeof dns.getServers;
  getNetworkInterfaces: typeof networkInterfaces;
}

function canConnect(hostname: string, addresses: dns.LookupAddress[], network: Pick<ImageUrlNetwork, "getDnsServers" | "getNetworkInterfaces">) {
  if (!addresses.length) return false;
  const restricted = addresses.filter(({ address }) => !isPublicAddress(address));
  if (!restricted.length) return true;
  if (isIP(hostname) || restricted.some(({ address }) =>
    !isFakeIp(address) || address === "198.18.0.0" || address === "198.19.255.255"
  )) return false;

  // The exception requires a local TUN/DNS address in the benchmark range.
  const localAddresses = [
    ...network.getDnsServers().map(dnsServerAddress),
    ...Object.values(network.getNetworkInterfaces()).flatMap((entries) => entries?.map(({ address }) => address) ?? []),
  ].map((address) => ipaddr.process(address).toString());
  return localAddresses.some(isFakeIp) && addresses.every(({ address }) => !localAddresses.includes(ipaddr.process(address).toString()));
}

export function createImageUrlDispatcher({
  dnsLookup = (hostname, callback) => dns.lookup(hostname, { all: true }, callback),
  getDnsServers = dns.getServers,
  getNetworkInterfaces = networkInterfaces,
}: Partial<ImageUrlNetwork> = {}) {
  // Validate the answers used by the socket itself, so no second lookup can change the destination.
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, (error, addresses) => {
          if (error) return callback(error, []);
          let allowed: boolean;
          try {
            allowed = canConnect(hostname, addresses, { getDnsServers, getNetworkInterfaces });
          } catch {
            return callback(invalidResponse(), []);
          }
          if (!allowed) return callback(invalidResponse(), []);
          const [first] = addresses;
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        });
      },
    },
  });
}

const imageUrlDispatcher = createImageUrlDispatcher();

function imageMimeType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  throw invalidResponse();
}

export async function downloadImageUrl(raw: string, signal: AbortSignal, dispatcher = imageUrlDispatcher) {
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
