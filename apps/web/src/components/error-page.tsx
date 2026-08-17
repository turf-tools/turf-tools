import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "~/components/button";
import { Callout } from "~/components/callout";
import { LightDarkToggle } from "~/components/light-dark-toggle";

// The router's defaultErrorComponent — every route match gets a real error
// boundary, so loader and render errors land here in place. The message is
// shown even in production; the full error (with stack) goes to the console.
// Recovery is a full reload: nearly every action saves immediately, so no
// in-page state is worth preserving over a clean restart.
export function ErrorPage({ error }: ErrorComponentProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const message = error instanceof Error ? error.message : String(error);

  // Prepopulated report — the error and page URL are the two things support
  // needs and the user shouldn't have to transcribe.
  const emailSupport = () => {
    const body = `Error: ${message}\nPage: ${window.location.href}`;
    window.location.href = `mailto:support@turf.tools?subject=${encodeURIComponent(
      "Turf Tools error report",
    )}&body=${encodeURIComponent(body)}`;
  };

  return (
    // dvh, not vh: mobile 100vh assumes collapsed browser chrome, so the
    // page overflows (and scrolls) while the URL bar is showing.
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-5 p-8">
      <div className="fixed top-3 right-4">
        <LightDarkToggle />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-2xl italic font-semibold mb-3">Sorry, something went wrong!</div>
        <div className="text-sm max-w-md text-muted-foreground mb-2">
          We've encountered an unexpected error. You can click below to email us the error message,
          and then reload the page. If you keep running into trouble, contact{" "}
          <a className="underline" href="mailto:support@turf.tools">
            support@turf.tools
          </a>
          .
        </div>
      </div>
      <Callout tone="neutral" className="max-h-44 w-full max-w-xl overflow-auto mb-3">
        {message}
      </Callout>
      <div className="flex gap-2">
        <Button variant="outline" onClick={emailSupport}>
          Email support
        </Button>
        <Button onClick={() => window.location.reload()}>Reload page</Button>
      </div>
    </div>
  );
}
