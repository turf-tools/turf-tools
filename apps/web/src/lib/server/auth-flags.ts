import { createServerFn } from "@tanstack/react-start";

// Per-deployment auth toggles, read from server env (never bundled to the
// client). `AUTH_REQUIRE_LINK_CONFIRMATION` makes the magic-link verify page
// fire the OTP POST on a button click instead of on mount. Detonation engines
// (e.g. Microsoft Safe Links) execute the page's JS — so an on-mount POST gets
// burned before the user acts — but they don't click buttons, so the click
// gate keeps the OTP alive. Off by default; deployments whose users sit behind
// such gateways flip it on, trading one click for scanner resistance.
export const getRequireLinkConfirmation = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => process.env.AUTH_REQUIRE_LINK_CONFIRMATION === "1",
);
