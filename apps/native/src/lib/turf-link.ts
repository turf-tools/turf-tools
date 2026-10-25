export type TurfLink = { host: string; code: string };

// A shared turf link takes the resolver form
// `https://to.turf.tools/t/<code>?host=<host>`: the resolver is the one
// domain the binary claims for universal links, so a tap opens the app no
// matter which deployment the turf lives on. The `/t/` path is the format
// discriminator that lets the in-app scanner reject arbitrary QR codes.
export const RESOLVER_HOST = "to.turf.tools";

// Two more shapes parse: a deployment's own `https://<host>/t/<code>`
// (the QR form), and the custom scheme `turf-tools://t/<code>?host=` the
// fallback pages use (`turf-tools-dev://` on the dev build). Regex (not
// `new URL`) — Hermes URL support is incomplete.
const LINK =
  /^(?:https?:\/\/([^/\s?#]+)\/|turf-tools(?:-dev)?:\/\/)t\/([A-Za-z0-9-]+)\/?(?:\?([^#\s]*))?(?:#.*)?$/;

export function parseTurfLink(data: string): TurfLink | null {
  const match = data.trim().match(LINK);
  if (!match) return null;
  const [, linkHost, code, query = ""] = match;
  if (linkHost && linkHost.toLowerCase() !== RESOLVER_HOST) return { host: linkHost, code: code! };
  const raw = query
    .split("&")
    .map((pair) => pair.split("="))
    .find(([key]) => key === "host")?.[1];
  if (!raw) return null;
  try {
    const host = normalizeHost(decodeURIComponent(raw));
    return host ? { host, code: code! } : null;
  } catch {
    return null;
  }
}

// Accepts what people paste — a scheme, a path, a trailing slash,
// whitespace — and keeps the bare host the RPC client expects.
export function normalizeHost(input: string): string {
  return input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

export function buildTurfLink(host: string, code: string): string {
  return `https://${RESOLVER_HOST}/t/${code}?host=${encodeURIComponent(host)}`;
}

// QR codes carry the deployment's own URL: every shipped scanner reads
// it, and a system-camera scan lands on that deployment's `/t/<code>`
// page. localhost/LAN hosts get http to match the RPC client's protocol
// rule.
export function buildTurfQr(host: string, code: string): string {
  const protocol = /^localhost(:|$)|^127\.|^192\.168\.|^10\./.test(host) ? "http" : "https";
  return `${protocol}://${host}/t/${code}`;
}
