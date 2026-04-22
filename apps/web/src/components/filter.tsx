import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { ChevronDown, Split } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listFilterAtom } from "~/lib/atoms/filters";
import { client } from "~/rpc/client";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// Filter controls for list-style pages (/lists, /turfs). Currently one
// track filter; more dimensions (tags, status, etc.) plug in alongside by
// adding controls here and expanding listFilterAtom. Text size is pinned
// to `text-sm` so it matches the breadcrumb, sidebar, and table — we
// want deliberate size variation, not one-off slightly-smaller chrome.
const ALL_TRACKS = "__all__";

export function Filter() {
  const [filter, setFilter] = useAtom(listFilterAtom);
  const [open, setOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);
  // Mount gate: server renders with the default atom value (trackId=null),
  // but the client has `getOnInit: true` so it reads the persisted value
  // synchronously — those diverge and React throws a hydration mismatch.
  // Pin the first client render to the server output, then flip to real
  // state after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: tracks } = useQuery({
    queryKey: ["tracks"],
    queryFn: () => client.tracks.list(),
    placeholderData: keepPreviousData,
  });

  const selectedTrack = tracks?.find((t) => t.trackId === filter.trackId);
  const trackLabel = mounted ? (selectedTrack?.name ?? "All tracks") : "All tracks";

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && pendingValueRef.current !== undefined) {
            const v = pendingValueRef.current;
            pendingValueRef.current = undefined;
            setFilter({ ...filter, trackId: v === ALL_TRACKS ? null : v });
          }
        }}
      >
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          <Split className="size-3.5" />
          <span>{trackLabel}</span>
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuRadioGroup
            value={filter.trackId ?? ALL_TRACKS}
            onValueChange={(v) => {
              pendingValueRef.current = v;
              setOpen(false);
            }}
          >
            <DropdownMenuRadioItem value={ALL_TRACKS}>All tracks</DropdownMenuRadioItem>
            {tracks?.map((t) => (
              <DropdownMenuRadioItem key={t.trackId} value={t.trackId}>
                {t.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
