// Every turf link — printed QR, copied link — takes the resolver form
// `https://to.turf.tools/t/<code>?host=<host>`: the resolver is the one
// domain the native app claims for universal links, so a tap or a
// system-camera scan opens the app no matter which deployment the turf
// lives on. The native scanner parses the same shape.
export const RESOLVER_HOST = "to.turf.tools";

export function buildTurfLink(host: string, code: string): string {
  return `https://${RESOLVER_HOST}/t/${code}?host=${encodeURIComponent(host)}`;
}
