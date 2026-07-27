import { type ReactNode, useState } from "react";
import type { SessionOrg } from "~/lib/server/session";
import { cn } from "~/lib/utils";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

// App shell: top bar + primary sidebar + main content, wrapped in a max-width
// centered container. Pages own their internal padding (use `<Page>` for the
// standard padded layout, or render directly for full-bleed editor routes).
type ShellProps = {
  children?: ReactNode;
  role: string | null;
  orgSlug: string;
  orgName: string;
  orgs: ReadonlyArray<SessionOrg>;
};

const EXPANDED_WIDTH = "w-40";
const COLLAPSED_WIDTH = "w-12";

export function Shell({ children, role, orgSlug, orgName, orgs }: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mx-auto min-h-screen max-w-[1600px]">
      <TopBar orgSlug={orgSlug} orgName={orgName} orgs={orgs} role={role} />
      <div className="flex">
        {/* Mobile has no sidebar — the top bar's menu button carries nav. */}
        <aside
          className={cn(
            "hidden md:block",
            "sticky top-14 z-30 h-[calc(100vh-3.5rem)]",
            "shrink-0 overflow-hidden",
            "border-r border-border",
            "transition-[width] duration-150",
            collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
          )}
        >
          <Sidebar
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            role={role}
            orgSlug={orgSlug}
          />
        </aside>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
