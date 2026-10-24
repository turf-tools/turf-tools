import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export type TurfLinkPlatform = "ios" | "android" | null;

// What the turf-link page needs from the request: the deployment's own
// host, and whether the visitor is on a phone (and which). Resolved on the
// server so the page is complete on its first paint.
export const getTurfLinkContext = createServerFn({ method: "GET" }).handler(
  (): { host: string; platform: TurfLinkPlatform } => {
    const headers = new Headers(getRequestHeaders());
    const ua = headers.get("user-agent") ?? "";
    return {
      host: headers.get("host") ?? "",
      platform: /iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : null,
    };
  },
);
