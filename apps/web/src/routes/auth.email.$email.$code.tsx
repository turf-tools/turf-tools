import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/button";
import { LightDarkToggle } from "~/components/light-dark-toggle";
import { LoadingIndicator } from "~/components/loading-indicator";
import { authClient } from "~/lib/auth-client";
import { getRequireLinkConfirmation } from "~/lib/server/auth-flags";
import { getSession } from "~/lib/server/session";

// Verify landing for the OTP embedded in email links. Verification always
// fires from a client-side POST, never a GET, so scanners that merely
// pre-fetch the URL can't burn the single-use OTP. Two modes, chosen
// per-deployment by AUTH_REQUIRE_LINK_CONFIRMATION:
//   - off (default): the POST fires on mount — zero-click magic link. Beats
//     pre-fetch scanners, but not detonation engines that execute page JS.
//   - on: the POST fires only on a button click. Detonation engines run the
//     JS but don't click, so the OTP survives the scan until the real user
//     acts. Costs one click; for deployments behind Safe-Links-style gateways.
// On failure (already used, expired, etc.) we surface a message + a button
// back to /login.
export const Route = createFileRoute("/auth/email/$email/$code")({
  beforeLoad: async () => {
    // Already signed in — skip the verify and bounce home. `reloadDocument`
    // is load-bearing: an internal redirect would reuse this route's auth-
    // flow bypass context (session=null) and loop back through /login.
    const session = await getSession();
    if (session) throw redirect({ to: "/", reloadDocument: true });
  },
  loader: async () => ({ requireConfirmation: await getRequireLinkConfirmation() }),
  component: VerifyPage,
});

function VerifyPage() {
  const { email, code } = Route.useParams();
  const { requireConfirmation } = Route.useLoaderData();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Guards a single component instance from firing the verify POST twice
  // (React's dev-mode double-effect, or a double button tap). Separate
  // navigations get a fresh component + fresh ref and are unaffected.
  const fired = useRef(false);

  const verify = async () => {
    if (fired.current) return;
    fired.current = true;
    setPending(true);
    const res = await authClient.signIn.emailOtp({ email, otp: code });
    if (res.error) {
      // All failure modes (already-used, expired, never-existed) collapse
      // here — the recovery is the same in every case: request a new link.
      setError("This link is no longer valid, please try again.");
      setPending(false);
      return;
    }
    // Hard-load to "/" — root's mount-time effect broadcasts the logged-in
    // signal with the user id. Broadcasting from this page would lack a
    // userId and trip the root listener's user-switch detection → reload loop.
    window.location.replace("/");
  };

  // Zero-click mode fires on mount; confirmation mode waits for the click.
  useEffect(() => {
    if (!requireConfirmation) void verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fire mode renders nothing until/unless it errors, so the redirect
  // feels instant.
  if (!error && !requireConfirmation) return null;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="fixed top-3 right-4 flex items-center gap-3">
        <LoadingIndicator />
        <LightDarkToggle />
      </div>
      <div className="w-full max-w-sm -mt-16 animate-in fade-in duration-100">
        <h1 className="mb-5 text-center text-5xl italic font-bold tracking-tight">Turf Tools</h1>
        {error ? (
          <>
            <p className="mb-8 text-center text-[16px] text-muted-foreground">{error}</p>
            <Link to="/login" className="block">
              <Button variant="outline" className="h-10 w-full text-[16px]">
                Return to login
              </Button>
            </Link>
          </>
        ) : (
          <>
            <p className="mb-8 text-center text-[16px] text-muted-foreground">
              Link verified, click below to finish logging in.
            </p>
            <Button
              type="button"
              onClick={() => void verify()}
              loading={pending}
              className="h-10 w-full text-[16px]"
            >
              Continue
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
