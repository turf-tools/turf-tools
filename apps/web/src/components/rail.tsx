import { Icon } from "~/components/icon";
import { type ReactNode, useEffect, useState } from "react";
import { Switch } from "~/components/switch";
import { cn } from "~/lib/utils";

// Show-archived toggle state for a rail. Resets itself when the last
// archived item disappears (e.g. everything got unarchived) so the
// toggle doesn't come back pre-enabled the next time something is
// archived — while any archived items remain, the choice sticks.
export function useShowArchived(archivedCount: number) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (archivedCount === 0) setShow(false);
  }, [archivedCount]);
  return [show, setShow] as const;
}

function RailRoot({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border">
      <div className="flex-1 overflow-y-auto pt-4 pb-2">{children}</div>
      {footer}
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

// Pinned rail-bottom toggle revealing archived items. Render (via the
// Rail `footer` prop) only when archived items exist — an org that
// never archived anything shouldn't see the control.
function RailShowArchived({
  show,
  onToggle,
}: {
  show: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between border-t border-border px-3 py-2.5 select-none">
      <span className="text-sm text-muted-foreground">Show archived</span>
      <Switch checked={show} onCheckedChange={onToggle} />
    </label>
  );
}

function RailNew({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  // No disabled styling on purpose: the pending window is brief and a
  // dimmed flash on every create reads worse than a silently inert button.
  disabled?: boolean;
}) {
  return (
    <div className="px-2 pb-1">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Icon name="plus" className="size-3.5 [stroke-width:2.25]" />
        <span>{label}</span>
      </button>
    </div>
  );
}

export const Rail = Object.assign(RailRoot, {
  Item: RailItem,
  New: RailNew,
  ShowArchived: RailShowArchived,
});
