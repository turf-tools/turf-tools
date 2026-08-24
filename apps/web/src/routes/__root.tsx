/// <reference types="vite/client" />
import { useEffect, useState, type ReactNode } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  redirect,
  useParams,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";

import { Shell } from "~/components/shell";
import { __registerNotifyStore } from "~/lib/notify";
import { getSession } from "~/lib/server/session";
import { detectDisplayTimezone } from "~/lib/timezones";
import { client } from "~/rpc/client";
// Side-effect import (not ?url): keeps the stylesheet in Vite's client
// module graph so CSS edits hot-inject instead of forcing a full reload
// (which re-runs SSR and a complete Tailwind scan). Start collects it
// into the SSR head in dev and emits the hashed asset link in prod.
import "~/styles.css";

// Cross-tab "logged-in" dedup — see the poster effect in RootComponent.
let lastPostedUserId: string | null = null;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Turf Tools" },
    ],
    links: [
      // Icons render via <use href="/sprite.svg#…"> (components/icon.tsx);
      // preloading keeps them from popping in after first paint.
      { rel: "preload", href: "/sprite.svg", as: "image", type: "image/svg+xml" },
      { rel: "icon", type: "image/png", href: "/favicon/arrow.png" },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/favicon/arrow.svg",
      },
      {
        rel: "mask-icon",
        href: "/favicon/arrow.svg",
      },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/favicon/arrow-180x180.png" },
    ],
  }),
  beforeLoad: async ({ location }) => {
    // Auth-flow routes can render without a session (that's the whole
    // point — the verify route is mid-login), so only the redirect is
    // skipped for them. The session itself is always resolved here:
    // every route must read ONE source of truth for "am I signed in" —
    // /login once ran its own getSession while "/" read this context,
    // and the two disagreeing during a login race produced a redirect
    // loop between them.
    const isAuthFlow =
      location.pathname === "/login" || location.pathname.startsWith("/auth/email/");
    const session = await getSession();
    if (!session && !isAuthFlow) throw redirect({ to: "/login" });
    return { session };
  },
  component: RootComponent,
});

function RootComponent() {
  const { queryClient, session } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { orgSlug } = useParams({ strict: false }) as { orgSlug?: string };
  const chromeless = pathname === "/login" || !orgSlug;
  const currentOrg = orgSlug && session ? (session.orgsBySlug[orgSlug] ?? null) : null;
  const role = currentOrg?.role ?? null;
  const orgs = session ? Object.values(session.orgsBySlug) : [];

  // Cross-tab auth signals.
  // - `logged-out`: any other tab signed out → bounce to /login.
  // - `logged-in` (different userId): another tab signed in as someone
  //   else, which silently replaces the auth cookie for *this* tab too.
  //   Hard-reload so the new session's data renders cleanly.
  const currentUserId = session?.user.id ?? null;
  useEffect(() => {
    const channel = new BroadcastChannel("auth");
    channel.onmessage = (e) => {
      if (e.data === "logged-out" && window.location.pathname !== "/login") {
        window.location.replace("/login");
        return;
      }
      if (
        typeof e.data === "object" &&
        e.data?.type === "logged-in" &&
        e.data.userId !== currentUserId
      ) {
        window.location.reload();
      }
    };
    return () => channel.close();
  }, [currentUserId]);

  // Cross-tab login signal. Listener (in routes/login.tsx) bounces any
  // /login tab to /; the above handler reloads sibling tabs on
  // user-switch. Posted ONCE per user per tab (module-level guard):
  // every logged-in post forces /login tabs to document-navigate, and
  // this effect re-runs on each navigation (the session object is
  // rebuilt per root beforeLoad) — re-posting on identity churn once
  // amplified a login race into a browser-throttled navigation storm.
  useEffect(() => {
    if (!currentUserId || currentUserId === lastPostedUserId) return;
    lastPostedUserId = currentUserId;
    const channel = new BroadcastChannel("auth");
    channel.postMessage({ type: "logged-in", userId: currentUserId });
    channel.close();
  }, [currentUserId]);

  // First-login TZ detection. session.user.displayTimezone is null until
  // this runs once and persists the browser-detected zone. Subsequent
  // sessions read the stored value; user can override on the Settings page.
  const router = useRouter();
  const needsTzDetect = session != null && session.user.displayTimezone == null;
  useEffect(() => {
    if (!needsTzDetect) return;
    void (async () => {
      try {
        await client.users.updateOwnDisplayTimezone({
          displayTimezone: detectDisplayTimezone(),
        });
        await router.invalidate();
      } catch (e) {
        console.error("users.updateOwnDisplayTimezone failed", e);
      }
    })();
  }, [needsTzDetect, router]);

  // Explicit store so imperative call sites (notify) share the tree's atoms.
  // Fresh per render tree on SSR; created once in the browser. Registration
  // is browser-only and idempotent, mirroring __registerRouter.
  const [jotaiStore] = useState(() => createStore());
  if (typeof window !== "undefined") __registerNotifyStore(jotaiStore);

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStore}>
        <RootDocument>
          {chromeless || !orgSlug || !currentOrg ? (
            <Outlet />
          ) : (
            <Shell role={role} orgSlug={orgSlug} orgName={currentOrg.orgName} orgs={orgs}>
              <Outlet />
            </Shell>
          )}
        </RootDocument>
      </JotaiProvider>
    </QueryClientProvider>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the dark class on <html> synchronously from localStorage,
            before React hydrates. Key must stay in sync with `darkAtom`'s
            storage key. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(JSON.parse(localStorage.getItem("dark"))===true)document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
