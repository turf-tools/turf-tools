/// <reference types="vite/client" />
import { useEffect, type ReactNode } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";

import { Shell } from "~/components/shell";
import { Toaster } from "~/components/sonner";
import { getSession } from "~/lib/server/session";
import appCss from "~/styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Field Tools" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/login") return { session: null };
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: RootComponent,
});

function RootComponent() {
  const { queryClient, session } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const chromeless = pathname === "/login";

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

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <RootDocument>
          {chromeless ? (
            <Outlet />
          ) : (
            <Shell role={session?.user.role ?? null}>
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
