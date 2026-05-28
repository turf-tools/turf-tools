import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "~/components/button";
import { LightDarkToggle } from "~/components/light-dark-toggle";
import { LoadingIndicator } from "~/components/loading-indicator";
import { authClient } from "~/lib/auth-client";
import { getSession } from "~/lib/server/session";

// Linear-style verify landing. The email contains a link to this URL with
// the OTP in the path. We deliberately do NOT verify on GET — the server
// just renders the page. Verification fires from a client-side effect, so
// scanner pre-fetches (which don't execute JS) never trigger the POST and
// can't burn the OTP. A real user's browser executes the effect and
// redirects them straight into the app.
//
// If a verify fails (already used, expired, JS-executing scanner, double
// click) the user sees a "link can't be used" message with a button back
// to /login where they can request a new one.
export const Route = createFileRoute("/auth/email/$email/$code")({
  beforeLoad: async () => {
    // If they're already signed in (e.g. clicked the same link twice in
    // the same session), skip the verify entirely and bounce home.
    // `reloadDocument` forces a full-document navigation so root's
    // beforeLoad re-runs with a fresh session lookup — an internal
    // redirect would reuse the auth-flow bypass context (session=null)
    // from this route and bounce back through /login in a loop.
    const session = await getSession();
    if (session) throw redirect({ to: "/", reloadDocument: true });
  },
  component: VerifyPage,
});

function VerifyPage() {
  const { email, code } = Route.useParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await authClient.signIn.emailOtp({ email, otp: code });
      if (cancelled) return;
      if (res.error) {
        // Common reasons collapse into one message: already used (scanner
        // burned it, or user clicked twice from different sessions),
        // expired, or never existed. Recovery is the same — request a
        // new link.
        setError("This link is no longer valid, please try again.");
        return;
      }
      // Hard-load to "/" — root's mount-time effect broadcasts the
      // logged-in signal (with userId) so any sibling /login tabs
      // transition too. Broadcasting from here would lack a userId and
      // trip the root listener's user-switch detection → reload loop.
      window.location.replace("/");
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount — `email`/`code` come from URL params and don't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Truly blank during the in-flight POST so the redirect lands as fast
  // as the prior magic-link flow — even the spinner briefly visible feels
  // distracting at this scale.
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
