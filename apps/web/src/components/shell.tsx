import { type ReactNode, useState } from "react";
import { cn } from "~/lib/utils";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

// App shell: top bar + sidebar + main content, all wrapped in a max-width
// centered container so on wide viewports the whole app has whitespace on
// both sides rather than the sidebar pinning to the viewport edge with
// content floating in a narrower band. Top bar and sidebar use sticky
// positioning so they stay put as content scrolls. Main area bleeds to
// the wrapper's right edge; pages add their own internal spacing/width.
type ShellProps = {
  children?: ReactNode;
};

const EXPANDED_WIDTH = "w-40";
const COLLAPSED_WIDTH = "w-12";

export function Shell({ children }: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mx-auto min-h-screen max-w-[1600px]">
      <TopBar />
      <div className="flex">
        <aside
          className={cn(
            "sticky top-14 z-30 h-[calc(100vh-3.5rem)]",
            "shrink-0 overflow-hidden",
            "border-r border-border",
            "transition-[width] duration-150",
            collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
          )}
        >
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </aside>
        <main className="flex-1 px-8 pt-4 pb-8">{children}</main>
      </div>
    </div>
  );
}
