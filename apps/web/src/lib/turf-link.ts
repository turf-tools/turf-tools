// A shared turf link takes the resolver form
// `https://to.turf.tools/t/<code>?host=<host>`: the resolver is the one
// domain the native app claims for universal links, so a tap opens the app
// no matter which deployment the turf lives on. QR codes carry the
// deployment's own `https://<host>/t/<code>` instead; the native scanner
// reads both.
export const RESOLVER_HOST = "to.turf.tools";

export function buildTurfLink(host: string, code: string): string {
  return `https://${RESOLVER_HOST}/t/${code}?host=${encodeURIComponent(host)}`;
}
