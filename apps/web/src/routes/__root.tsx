/// <reference types="vite/client" />
import { useEffect, type ReactNode } from "react";
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
import { Provider as JotaiProvider } from "jotai";

import { Shell } from "~/components/shell";
import { Toaster } from "~/components/sonner";
import { getSession } from "~/lib/server/session";
import { detectDisplayTimezone } from "~/lib/timezones";
import { client } from "~/rpc/client";
import appCss from "~/styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Field Tools" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon/toolbox.png" },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 120 120%22><text x=%220%22 y=%22100%22 font-size=%22100%22>🧰</text></svg>",
      },
      {
        rel: "mask-icon",
        href: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 120 120%22><text x=%220%22 y=%22100%22 font-size=%22100%22>🧰</text></svg>",
      },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/favicon/toolbox-180x180.png" },
    ],
  }),
  beforeLoad: async ({ location }) => {
    // Auth-flow routes can be hit without a session (that's the whole
    // point — the verify route is mid-login). Skip the gate for them.
    const isAuthFlow =
      location.pathname === "/login" || location.pathname.startsWith("/auth/email/");
    if (isAuthFlow) return { session: null };
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
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

  // Cross-tab login signal — fires on mount whenever this tab is authed.
  // Listener (in routes/login.tsx) bounces any /login tab to /; the
  // above handler reloads sibling tabs on user-switch.
  useEffect(() => {
    if (!session) return;
    const channel = new BroadcastChannel("auth");
    channel.postMessage({ type: "logged-in", userId: session.user.id });
    channel.close();
  }, [session]);

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

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <RootDocument>
          {chromeless || !orgSlug || !currentOrg ? (
            <Outlet />
          ) : (
            <Shell role={role} orgSlug={orgSlug} orgName={currentOrg.orgName} orgs={orgs}>
              <Outlet />
            </Shell>
          )}
          <Toaster />
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
