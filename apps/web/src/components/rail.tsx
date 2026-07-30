import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

function RailRoot({ children }: { children: ReactNode }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border">
      <div className="flex-1 overflow-y-auto pt-4 pb-2">{children}</div>
    </aside>
  );
}

function RailItem({
  label,
  active,
  trailing,
  onSelect,
  onRename,
}: {
  label: string;
  active: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
  onRename?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      // Skip the focus side-effect of mousedown so click doesn't leave a
      // focus ring after a dialog returns focus here. Tab navigation is
      // unaffected.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!active) onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!active) onSelect();
        onRename?.();
      }}
      className={cn(
        "mx-2 my-0.5 flex cursor-pointer items-center rounded-md px-2 py-1 text-sm select-none",
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

function RailNew({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="px-2 pb-1">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Plus className="size-3.5 [stroke-width:2.25]" />
        <span>{label}</span>
      </button>
    </div>
  );
}

export const Rail = Object.assign(RailRoot, {
  Item: RailItem,
  New: RailNew,
});
