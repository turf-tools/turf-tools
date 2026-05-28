import { DoorClosed, Trash2, UserRound } from "lucide-react";
import { Button } from "~/components/button";
import { Pill } from "~/components/pill";
import { cn } from "~/lib/utils";
import { colorFor } from "~/lib/zone-colors";

// Sidebar list of turfs the user has cut in the current zone.
// Names are auto-numbered "Turf 1..N" — turfs aren't worth letting
// users name; only zones are. Colors cycle through the categorical
// palette by index, deliberately *not* tied to the owning zone's
// color so multiple turfs in the same zone are visually distinct.
//
// Selection is bidirectional with the map: clicking a row sets
// `selectedTurfId`, which the TurfDrawer reads to decide whose
// vertex handles to render. Clicking a turf polygon on the map
// flips the selection back here.
//
// Trash button removes the turf entirely. If the removed turf was
// the selected one, the parent's `setSelectedTurfId` should clear
// the selection (we don't auto-fall-back to a neighbor).

export type TurfRow = {
  id: string;
  // Per-turf aggregates over the segment buildings inside the
  // polygon. Undefined while still in `drawing` mode (the polygon
  // isn't a closed shape yet).
  counts: { doors: number; people: number } | undefined;
};

type Props = {
  turfs: ReadonlyArray<TurfRow>;
  selectedTurfId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  // Optional placeholder shown only when the list is empty. Caller
  // should leave this `undefined` while data is still loading so the
  // sidebar stays blank during the curtain — passing it in prematurely
  // makes the empty-state row flash before the user has any reason
  // to know the list is genuinely empty.
  emptyMessage?: string;
};

export function TurfList({ turfs, selectedTurfId, onSelect, onRemove, emptyMessage }: Props) {
  if (turfs.length === 0) {
    if (!emptyMessage) return <div className="h-full" />;
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto">
        <div
          className={cn(
            // Pinned to match a populated row's natural height so the
            // placeholder sits in the same slot.
            "flex h-[46px] items-center rounded-md border border-border bg-card",
            "py-2 pr-2 pl-3 text-sm",
          )}
        >
          {emptyMessage}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {turfs.map((turf, idx) => {
        const selected = turf.id === selectedTurfId;
        return (
          <div
            key={turf.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(turf.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(turf.id);
              }
            }}
            className={cn(
              "h-11 flex items-center gap-2 rounded-md border bg-card py-2 pr-2 pl-3 text-left",
              selected ? "border-foreground" : "border-border hover:border-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className="mr-1 size-3 shrink-0 rounded-sm border border-border"
              style={{ backgroundColor: colorFor(idx) }}
            />
            <span className="flex-1 truncate text-sm">Turf {idx + 1}</span>
            {turf.counts ? (
              <div className="flex shrink-0 items-center gap-2">
                <Pill
                  variant="number"
                  className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
                >
                  <UserRound className="size-3.5 text-foreground" />
                  {turf.counts.people.toLocaleString()}
                </Pill>
                <Pill
                  variant="number"
                  className="!w-fit shrink-0 gap-1.5 animate-in fade-in duration-100"
                >
                  <DoorClosed className="size-3.5 text-foreground" />
                  {turf.counts.doors.toLocaleString()}
                </Pill>
              </div>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              className="-ml-[1px] h-8"
              aria-label={`Remove turf ${idx + 1}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(turf.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
