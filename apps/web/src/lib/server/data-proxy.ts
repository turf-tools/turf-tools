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

// Structured failure for upstream-returned non-2xx. Carries the HTTP
// status and FastAPI's `{detail}` message so RPC handlers can map to
// the right ORPCError code (e.g. 400 → BAD_REQUEST with the detail
// surfaced to the user).
export class DataServiceError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly path: string;
  constructor(status: number, detail: string, path: string) {
    super(`data ${path} failed: ${status} ${detail}`);
    this.name = "DataServiceError";
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

// Typed POST { ...body } → JSON helper for oRPC handlers that proxy a
// JSON request to data and parse JSON back. Throws DataServiceError on
// non-2xx, parsing FastAPI's `{detail}` envelope when present.
export async function dataPostJson<T>(path: string, body: unknown): Promise<T> {
  const res = await dataFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // body wasn't JSON — fall back to raw text
    }
    throw new DataServiceError(res.status, detail, path);
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
