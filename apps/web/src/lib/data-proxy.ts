// Server-only helpers for talking to the data service. The data service
// is internal — never reachable from the browser. Every public endpoint
// (oRPC handler or /api proxy route) funnels through here, so the URL,
// the upstream-failure shape, and the streaming pass-through pattern
// all live in one place.

// Read at call-time so Nitro / dev server reloads pick it up without
// needing to re-import. Vite only injects `VITE_*` vars into
// import.meta.env; non-prefixed vars live on process.env server-side.
function dataUrl(path: string): string {
  const base = process.env.DATA_URL;
  if (!base) throw new Error("DATA_URL is not set");
  return `${base}${path}`;
}

// Generic fetch against the data service. Caller controls method/body/headers.
export function dataFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(dataUrl(path), init);
}

// Typed POST { ...body } → JSON helper for oRPC handlers that proxy a
// JSON request to data and parse JSON back. Throws on non-2xx with the
// upstream body included for diagnosis.
export async function dataPostJson<T>(path: string, body: unknown): Promise<T> {
  const res = await dataFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`data ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Pass-through: forward an upstream Response to the browser, streaming the
// body and preserving Content-Type / Cache-Control. Used by /api routes
// that handle large or binary payloads we don't want to parse + re-serialize.
export function passthrough(upstream: Response, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  const ct = upstream.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  const cc = upstream.headers.get("Cache-Control");
  if (cc) headers.set("Cache-Control", cc);
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
