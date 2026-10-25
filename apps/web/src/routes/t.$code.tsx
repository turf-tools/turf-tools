import { createFileRoute } from "@tanstack/react-router";
import { Button } from "~/components/button";
import { getTurfLinkContext } from "~/lib/server/turf-link";

const APP_STORE = "https://apps.apple.com/app/id6794649475";
const PLAY_STORE = "https://play.google.com/store/apps/details?id=tools.turf.app";
const PACKAGE = "tools.turf.app";

export const Route = createFileRoute("/t/$code")({
  head: () => ({ meta: [{ title: "Open turf in Turf Tools" }] }),
  loader: () => getTurfLinkContext(),
  component: TurfLinkPage,
});

// Where a system-camera scan of a turf QR lands: the deployment's own
// `/t/<code>`. No session, no lookup — the values come first because they
// work in any version of the app; the open button needs a version that
// handles links.
function TurfLinkPage() {
  const { code } = Route.useParams();
  const { host, platform } = Route.useLoaderData();

  // iOS: the custom scheme, which Safari confirms with "Open in Turf
  // Tools?". Android: an intent link that opens the app when installed
  // and falls through to the store otherwise.
  const target = `t/${code}?host=${encodeURIComponent(host)}`;
  const openHref =
    platform === "ios"
      ? `turf-tools://${target}`
      : `intent://${target}#Intent;scheme=turf-tools;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE)};end`;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm text-center text-[16px] leading-[1.35]">
        <h1 className="mb-5 text-5xl italic font-bold tracking-tight">Turf Tools</h1>
        <p className="mb-6 text-muted-foreground">
          To load this turf, open the Turf Tools app on iOS or Android and enter these two values,
          or tap the button below to open it directly.
        </p>
        <dl className="rounded-lg border border-border bg-card px-4 py-3">
          <dt className="text-muted-foreground">Web address</dt>
          <dd className="mb-3 break-all">{host}</dd>
          <dt className="text-muted-foreground">Turf code</dt>
          <dd className="tabular-nums">{code}</dd>
        </dl>
        {platform ? (
          <div className="mt-7 flex flex-col gap-3">
            <Button
              className="h-12 md:h-10 text-[16px]"
              nativeButton={false}
              render={<a href={openHref} />}
            >
              Open in Turf Tools
            </Button>
            <Button
              variant="outline"
              className="h-12 md:h-10 text-[16px]"
              nativeButton={false}
              render={<a href={platform === "ios" ? APP_STORE : PLAY_STORE} />}
            >
              Get the app
            </Button>
            <p className="mt-1 text-muted-foreground">
              To open the turf directly you will need the latest version of the app.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
