export type ScannedEntry = { host: string; code: string };

// A turf QR encodes `https://<host>/t/<code>` — a real URL so a system-camera
// scan can someday land on a web page / universal link, while the `/t/` path
// is the format discriminator that lets the in-app scanner reject arbitrary
// QR codes. Regex (not `new URL`) — Hermes URL support is incomplete.
export function parseTurfQr(data: string): ScannedEntry | null {
  const match = data.trim().match(/^https?:\/\/([^/\s]+)\/t\/([A-Za-z0-9-]+)\/?$/);
  if (!match) return null;
  return { host: match[1]!, code: match[2]! };
}
