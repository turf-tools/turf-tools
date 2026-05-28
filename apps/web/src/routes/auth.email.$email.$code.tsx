import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/button";
import { LightDarkToggle } from "~/components/light-dark-toggle";
import { LoadingIndicator } from "~/components/loading-indicator";
import { authClient } from "~/lib/auth-client";
import { getSession } from "~/lib/server/session";

// Verify landing for the OTP embedded in email links. The GET serves an
// inert page; verification fires from a client-side effect on mount, so
// GET-based email scanners that pre-fetch the URL can't trigger the POST
// and can't burn the OTP. Real browsers execute the effect and redirect
// into the app. On failure (already used, expired, etc.) we surface a
// message with a button back to /login.
export const Route = createFileRoute("/auth/email/$email/$code")({
  beforeLoad: async () => {
    // Already signed in — skip the verify and bounce home. `reloadDocument`
    // is load-bearing: an internal redirect would reuse this route's auth-
    // flow bypass context (session=null) and loop back through /login.
    const session = await getSession();
    if (session) throw redirect({ to: "/", reloadDocument: true });
  },
  component: VerifyPage,
});

function VerifyPage() {
  const { email, code } = Route.useParams();
  const [error, setError] = useState<string | null>(null);
  // Guards a single component instance from firing the verify POST twice
  // (notably React's dev-mode double-effect). Separate navigations get a
  // fresh component + fresh ref and are unaffected.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void (async () => {
      const res = await authClient.signIn.emailOtp({ email, otp: code });
      if (res.error) {
        // All failure modes (already-used, expired, never-existed) collapse
        // here — the recovery is the same in every case: request a new link.
        setError("This link is no longer valid, please try again.");
        return;
      }
      // Hard-load to "/" — root's mount-time effect broadcasts the
      // logged-in signal with the user id. Broadcasting from this page
      // would lack a userId and trip the root listener's user-switch
      // detection → reload loop.
      window.location.replace("/");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Truly blank during the in-flight POST so the redirect feels instant.
  if (!error) return null;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="fixed top-3 right-4 flex items-center gap-3">
        <LoadingIndicator />
        <LightDarkToggle />
      </div>
      <div className="w-full max-w-sm -mt-16 animate-in fade-in duration-100">
        <h1 className="mb-5 text-center text-5xl italic font-bold tracking-tight">Field Tools</h1>
        <p className="mb-8 text-center text-[16px] text-muted-foreground">{error}</p>
        <Link to="/login" className="block">
          <Button className="h-10 w-full text-[16px]">Return to login</Button>
        </Link>
      </div>
    </div>
  );
}
