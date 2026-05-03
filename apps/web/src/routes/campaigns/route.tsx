import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useChildMatches,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { ChevronDown, Copy, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Input } from "~/components/input";
import { KEY_GROUPS_AVAILABLE } from "~/lib/key-groups";
import { boundariesGeoJsonQuery } from "~/lib/queries/boundaries";
import {
  campaignKeyCountsQuery,
  campaignPointsQuery,
  campaignsListQuery,
  type KeyFilter,
} from "~/lib/queries/campaigns";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { segmentDetailQuery, segmentsListQuery } from "~/lib/queries/segments";
import { turfStatsForCampaignQuery } from "~/lib/queries/turfs";
import { zoneGroupsQuery, zonesQuery } from "~/lib/queries/zones";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

// Sorted union of all keys across the zone group's zones, used as the
// `keyFilter` for points and per-key counts.
function deriveKeyFilter(
  zoneGroup: { keyGroup: string } | null | undefined,
  zones: Awaited<ReturnType<typeof client.zones.list>> | null | undefined,
): KeyFilter | null {
  if (!zoneGroup || !zones) return null;
  return {
    keyGroup: zoneGroup.keyGroup,
    keys: Array.from(new Set(zones.flatMap((z) => z.keys))).sort(),
  };
}

export const Route = createFileRoute("/campaigns")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(zoneGroupsQuery()),
      queryClient.fetchQuery(scriptsListQuery()),
    ]);
  },
  component: CampaignsLayout,
});

function CampaignsLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { campaignId?: string };
  const activeCampaignId = params.campaignId ?? null;
  const shouldFade = useFadeOnce("/campaigns");

  // Cutter takes the entire content area; skip the editor header in that
  // case. Reads the *committed* match (not the eager pathname) so the
  // header doesn't flicker during the cutter's loader run.
  const childMatches = useChildMatches();
  const isCut = childMatches.some((m) => m.routeId.endsWith("/cut/$zoneId"));

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const { data: scripts } = useSuspenseQuery(scriptsListQuery());

  const sortedCampaigns = sortByName(campaigns);
  const activeCampaign = campaigns.find((c) => c.campaignId === activeCampaignId) ?? null;
  // Configure / rename / duplicate / delete need the bound segment + zone group
  // ids, which only live on the detail row. Fall back to the list row for the
  // pre-detail case (e.g., empty state).
  const campaignDetail = activeCampaignId
    ? queryClient.getQueryData<Awaited<ReturnType<typeof client.campaigns.getById>>>([
        "campaign",
        activeCampaignId,
      ])
    : null;
  const campaign = campaignDetail ?? activeCampaign;

  const goToCampaign = (id: string) =>
    navigate({ to: "/campaigns/$campaignId", params: { campaignId: id } });

  // Mirror of the editor-route loader's prefetch logic — used by the
  // create/clone flows to warm caches against the new campaign's
  // bindings before the navigate, so the body's queries cache-hit.
  const prefetchCampaignViewData = async (target: {
    campaignId: string;
    segmentId: string | null;
    zoneGroupId: string | null;
  }) => {
    const zgs = await queryClient.fetchQuery(zoneGroupsQuery());
    const nextZoneGroup = zgs.find((g) => g.zoneGroupId === target.zoneGroupId) ?? null;
    const [nextSegmentDetail, nextZones] = await Promise.all([
      target.segmentId
        ? queryClient.fetchQuery(segmentDetailQuery(target.segmentId))
        : Promise.resolve(undefined),
      target.zoneGroupId
        ? queryClient.fetchQuery(zonesQuery(target.zoneGroupId))
        : Promise.resolve(undefined),
    ]);
    const nextKeyFilter = deriveKeyFilter(nextZoneGroup, nextZones);
    await Promise.all([
      queryClient.prefetchQuery(turfStatsForCampaignQuery(target.campaignId)),
      nextZoneGroup
        ? queryClient.prefetchQuery(
            boundariesGeoJsonQuery(nextZoneGroup.keyGroup, nextZoneGroup.updatedAt),
          )
        : Promise.resolve(),
      nextSegmentDetail?.criteria && nextKeyFilter
        ? queryClient.prefetchQuery(campaignPointsQuery(nextSegmentDetail.criteria, nextKeyFilter))
        : Promise.resolve(),
      nextSegmentDetail?.criteria && nextKeyFilter
        ? queryClient.prefetchQuery(
            campaignKeyCountsQuery(
              nextSegmentDetail.criteria,
              nextKeyFilter.keyGroup,
              nextKeyFilter.keys,
            ),
          )
        : Promise.resolve(),
    ]);
  };

  const seedCampaignCache = (created: Awaited<ReturnType<typeof client.campaigns.create>>) => {
    queryClient.setQueryData<Awaited<ReturnType<typeof client.campaigns.list>>>(
      ["campaigns"],
      (old) => (old ? [...old, created] : [created]),
    );
    queryClient.setQueryData(["campaign", created.campaignId], created);
  };

  const renameCampaign = useDialogMutation({
    mutationFn: (input: { campaignId: string; name: string }) => client.campaigns.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
  });

  // Wrapping zoneGroups.createWithDefaultZone + campaigns.create in one
  // mutation so the dialog's pending/error UX is coherent across both paths.
  const createCampaign = useDialogMutation({
    mutationFn: async (input: {
      name: string;
      segmentId: string;
      scriptId: string;
      zoneGroupId: string | null;
      constructFromKeyGroup: string | null;
    }) => {
      let zoneGroupId = input.zoneGroupId;
      if (input.constructFromKeyGroup) {
        const zg = await client.zoneGroups.createWithDefaultZone({
          name: `${input.name} zones`,
          keyGroup: input.constructFromKeyGroup,
          segmentId: input.segmentId,
        });
        zoneGroupId = zg.zoneGroupId;
        void queryClient.invalidateQueries({ queryKey: ["zone-groups"] });
      }
      const created = await client.campaigns.create({
        name: input.name,
        segmentId: input.segmentId,
        scriptId: input.scriptId,
        zoneGroupId,
      });
      seedCampaignCache(created);
      return created;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      return goToCampaign(created.campaignId);
    },
  });

  const cloneCampaign = useDialogMutation({
    mutationFn: async (input: { campaignId: string; newName: string }) => {
      const created = await client.campaigns.clone(input);
      seedCampaignCache(created);
      return created;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      return goToCampaign(created.campaignId);
    },
  });

  const deleteCampaign = useDialogMutation({
    mutationFn: (campaignId: string) => client.campaigns.remove({ campaignId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  const updateCampaignMutation = useMutation({
    mutationFn: (input: {
      campaignId: string;
      segmentId?: string | null;
      zoneGroupId?: string | null;
      scriptId?: string | null;
    }) => client.campaigns.update(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["campaign", input.campaignId] });
      const previous = queryClient.getQueryData(["campaign", input.campaignId]);
      queryClient.setQueryData(
        ["campaign", input.campaignId],
        (old: Record<string, unknown> | null | undefined) => {
          if (!old) return old;
          const next = { ...old };
          if (input.segmentId !== undefined) next.segmentId = input.segmentId;
          if (input.zoneGroupId !== undefined) next.zoneGroupId = input.zoneGroupId;
          if (input.scriptId !== undefined) next.scriptId = input.scriptId;
          return next;
        },
      );
      return { previous };
    },
    onError: (e, input, ctx) => {
      console.error("campaigns.update failed", e);
      if (ctx?.previous) queryClient.setQueryData(["campaign", input.campaignId], ctx.previous);
    },
  });

  const [configOpen, setConfigOpen] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  // Snapshotted at click time so the dialog body keeps showing the
  // just-deleted name during its close animation, even after the URL
  // has reactively swapped to the fallback campaign.
  const [deleteSnapshot, setDeleteSnapshot] = useState({ name: "", turfCount: 0 });

  const onConfirmDelete = () => {
    if (!activeCampaignId) return;
    const idx = sortedCampaigns.findIndex((c) => c.campaignId === activeCampaignId);
    const fallback = sortedCampaigns[idx - 1] ?? sortedCampaigns[idx + 1] ?? null;
    deleteCampaign.mutate(activeCampaignId, {
      onSuccess: async () => {
        if (fallback) {
          await goToCampaign(fallback.campaignId);
        } else {
          await navigate({ to: "/campaigns" });
        }
      },
    });
  };

  const saveConfigure = async (patch: {
    segmentId: string | null;
    zoneGroupId: string | null;
    scriptId: string | null;
  }) => {
    if (!activeCampaignId) return;
    setConfigSaving(true);
    try {
      // Warm caches against the new bindings before the optimistic
      // detail update fires, so the body's queries cache-hit on
      // rebind and the `ready` curtain never drops.
      await prefetchCampaignViewData({
        campaignId: activeCampaignId,
        segmentId: patch.segmentId,
        zoneGroupId: patch.zoneGroupId,
      });
      updateCampaignMutation.mutate({ campaignId: activeCampaignId, ...patch });
      setConfigOpen(false);
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "-mx-8 -mt-5 -mb-8 flex h-[calc(100vh-3.5rem)]",
          shouldFade && "animate-in fade-in duration-100",
        )}
      >
        {/* Secondary sidebar — full-height compact list */}
        <aside className="flex w-60 shrink-0 flex-col overflow-hidden border-r border-border">
          <div className="flex-1 overflow-y-auto pb-2 pt-5">
            {sortedCampaigns.map((c) => {
              const isActive = c.campaignId === activeCampaignId;
              return (
                <div
                  key={c.campaignId}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!isActive) void goToCampaign(c.campaignId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void goToCampaign(c.campaignId);
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!isActive) void goToCampaign(c.campaignId);
                    renameCampaign.open();
                  }}
                  className={cn(
                    "mx-2 my-0.5 flex cursor-pointer items-center rounded-md px-3 py-1 text-sm select-none",
                    isActive
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span className="flex-1 truncate">{c.name}</span>
                </div>
              );
            })}
            <div className="px-2 pb-1">
              <button
                type="button"
                onClick={createCampaign.open}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Plus className="size-3.5" />
                <span>New campaign</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Editor column: header (only outside cutter) + Outlet */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-5 pt-5 pb-5">
          {!isCut ? (
            <div className="mb-4 flex h-8 items-center justify-between">
              <div className="flex items-baseline gap-3">
                <h1 className="text-xl font-extrabold tracking-wide italic">Campaign Editor</h1>
                <span className="text-sm text-muted-foreground italic">
                  {activeCampaign?.name ?? ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfigOpen(true)}
                  disabled={!activeCampaign}
                >
                  <Settings2 />
                  Configure
                </Button>
                <Button variant="outline" onClick={renameCampaign.open} disabled={!activeCampaign}>
                  <Pencil />
                  Rename
                </Button>
                <Button variant="outline" onClick={cloneCampaign.open} disabled={!activeCampaign}>
                  <Copy />
                  Duplicate
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!activeCampaignId) return;
                    const { count } = await queryClient.fetchQuery({
                      queryKey: ["campaigns", "count-turfs", activeCampaignId],
                      queryFn: () =>
                        client.turfs.countForCampaign({ campaignId: activeCampaignId }),
                      staleTime: 0,
                    });
                    setDeleteSnapshot({ name: activeCampaign?.name ?? "", turfCount: count });
                    deleteCampaign.open();
                  }}
                  disabled={!activeCampaign}
                >
                  <Trash2 />
                  Delete
                </Button>
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </div>
      </div>

      <CreateCampaignDialog
        open={createCampaign.isOpen}
        onOpenChange={createCampaign.onOpenChange}
        pending={createCampaign.isPending}
        error={createCampaign.error}
        segmentOptions={segments.map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={zoneGroups.map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={scripts.map((s) => ({ value: s.scriptId, label: s.name }))}
        onSubmit={(values) => createCampaign.mutate(values)}
      />

      <SaveAsDialog
        open={cloneCampaign.isOpen}
        onOpenChange={cloneCampaign.onOpenChange}
        defaultName={activeCampaign ? `${activeCampaign.name} (copy)` : ""}
        pending={cloneCampaign.isPending}
        error={cloneCampaign.error}
        onSubmit={(newName) => {
          if (!activeCampaignId) return;
          cloneCampaign.mutate({ campaignId: activeCampaignId, newName });
        }}
      />

      <RenameDialog
        open={renameCampaign.isOpen}
        onOpenChange={renameCampaign.onOpenChange}
        currentName={activeCampaign?.name ?? ""}
        pending={renameCampaign.isPending}
        error={renameCampaign.error}
        onSubmit={(name) => {
          if (!activeCampaignId) return;
          renameCampaign.mutate({ campaignId: activeCampaignId, name });
        }}
      />

      <DeleteDialog
        open={deleteCampaign.isOpen}
        onOpenChange={deleteCampaign.onOpenChange}
        campaignName={deleteSnapshot.name}
        turfCount={deleteSnapshot.turfCount}
        pending={deleteCampaign.isPending}
        error={deleteCampaign.error}
        onConfirm={onConfirmDelete}
      />

      <ConfigureDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        currentSegmentId={campaign?.segmentId ?? null}
        currentZoneGroupId={campaign?.zoneGroupId ?? null}
        currentScriptId={campaign?.scriptId ?? null}
        segmentOptions={segments.map((s) => ({ value: s.segmentId, label: s.name }))}
        zoneGroupOptions={zoneGroups.map((g) => ({ value: g.zoneGroupId, label: g.name }))}
        scriptOptions={scripts.map((s) => ({ value: s.scriptId, label: s.name }))}
        pending={configSaving}
        onSubmit={(patch) => void saveConfigure(patch)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialog components
// ---------------------------------------------------------------------------

type SelectOption = { value: string; label: string };

// Sentinel for the "construct fresh zone group from key group" path —
// sits alongside real zone-group ids in the create-dialog dropdown.
const AUTO_ZONES_SENTINEL = "__auto__";

function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10",
        "px-3 py-2 text-sm text-destructive",
      )}
    >
      {error}
    </div>
  );
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  pending,
  error,
  segmentOptions,
  zoneGroupOptions,
  scriptOptions,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  segmentOptions: ReadonlyArray<SelectOption>;
  zoneGroupOptions: ReadonlyArray<SelectOption>;
  scriptOptions: ReadonlyArray<SelectOption>;
  onSubmit: (values: {
    name: string;
    segmentId: string;
    scriptId: string;
    zoneGroupId: string | null;
    constructFromKeyGroup: string | null;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [zonesValue, setZonesValue] = useState<string | null>(null);
  const [constructKeyGroup, setConstructKeyGroup] = useState<string>(
    KEY_GROUPS_AVAILABLE[0]!.value,
  );
  useEffect(() => {
    if (open) {
      setName("");
      setSegmentId(null);
      setScriptId(null);
      setZonesValue(null);
      setConstructKeyGroup(KEY_GROUPS_AVAILABLE[0]!.value);
    }
  }, [open]);

  const isAuto = zonesValue === AUTO_ZONES_SENTINEL;
  const zonesOptions: ReadonlyArray<SelectOption> = [
    { value: AUTO_ZONES_SENTINEL, label: "Define automatically" },
    ...zoneGroupOptions,
  ];
  const validZones = zonesValue !== null && (!isAuto || constructKeyGroup !== "");
  const valid = name.trim().length > 0 && segmentId !== null && scriptId !== null && validZones;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new campaign</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people), a group of zones (geography), and a script
          (questions). Choices can be edited later via Configure.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit({
              name: name.trim(),
              segmentId: segmentId!,
              scriptId: scriptId!,
              zoneGroupId: isAuto ? null : zonesValue,
              constructFromKeyGroup: isAuto ? constructKeyGroup : null,
            });
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
          <ConfigField
            label="Segment"
            placeholder="Pick a segment…"
            value={segmentId}
            options={segmentOptions}
            onChange={setSegmentId}
          />
          <ConfigField
            label="Zones"
            placeholder="Pick a zone group…"
            value={zonesValue}
            options={zonesOptions}
            onChange={setZonesValue}
          />
          {isAuto ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted-foreground">Define from</label>
              <KeyGroupRadio value={constructKeyGroup} onChange={setConstructKeyGroup} />
            </div>
          ) : null}
          <ConfigField
            label="Script"
            placeholder="Pick a script…"
            value={scriptId}
            options={scriptOptions}
            onChange={setScriptId}
          />
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SaveAsDialog({
  open,
  onOpenChange,
  defaultName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (newName: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Duplicate campaign</DialogTitle>
        <DialogDescription>
          Creates a copy of the current campaign, including its bindings.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Duplicate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  currentName,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename campaign</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(name.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5 mt-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <DialogError error={error} />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  campaignName,
  turfCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignName: string;
  turfCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = turfCount > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete campaign?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{campaignName}</span>{" "}
              because it has <span className="font-bold text-foreground">{turfCount}</span>{" "}
              published turf{turfCount === 1 ? "" : "s"}. Turfs can't be removed yet — clearing them
              is a follow-up.
            </>
          ) : (
            <>
              Permanently deletes{" "}
              <span className="font-medium text-foreground">{campaignName}</span>. This can't be
              undone.
            </>
          )}
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          {inUse ? (
            <DialogClose render={<Button variant="outline" />}>Ok</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                Delete campaign
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConfigureDialog({
  open,
  onOpenChange,
  currentSegmentId,
  currentZoneGroupId,
  currentScriptId,
  segmentOptions,
  zoneGroupOptions,
  scriptOptions,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSegmentId: string | null;
  currentZoneGroupId: string | null;
  currentScriptId: string | null;
  segmentOptions: ReadonlyArray<SelectOption>;
  zoneGroupOptions: ReadonlyArray<SelectOption>;
  scriptOptions: ReadonlyArray<SelectOption>;
  pending: boolean;
  onSubmit: (patch: {
    segmentId: string | null;
    zoneGroupId: string | null;
    scriptId: string | null;
  }) => void;
}) {
  const [segmentId, setSegmentId] = useState(currentSegmentId);
  const [zoneGroupId, setZoneGroupId] = useState(currentZoneGroupId);
  const [scriptId, setScriptId] = useState(currentScriptId);

  useEffect(() => {
    if (open) {
      setSegmentId(currentSegmentId);
      setZoneGroupId(currentZoneGroupId);
      setScriptId(currentScriptId);
    }
  }, [open, currentSegmentId, currentZoneGroupId, currentScriptId]);

  const dirty =
    segmentId !== currentSegmentId ||
    zoneGroupId !== currentZoneGroupId ||
    scriptId !== currentScriptId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Configure campaign</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people), a group of zones (geography), and a script
          (questions). You can change the choices here.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty) {
              onOpenChange(false);
              return;
            }
            onSubmit({ segmentId, zoneGroupId, scriptId });
          }}
          className="mt-2 flex flex-col gap-3"
        >
          <ConfigField
            label="Segment"
            placeholder="Pick a segment…"
            value={segmentId}
            options={segmentOptions}
            onChange={setSegmentId}
          />
          <ConfigField
            label="Zones"
            placeholder="Pick a zone group…"
            value={zoneGroupId}
            options={zoneGroupOptions}
            onChange={setZoneGroupId}
          />
          <ConfigField
            label="Script"
            placeholder="Pick a script…"
            value={scriptId}
            options={scriptOptions}
            onChange={setScriptId}
          />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!dirty || pending} loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigField({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string | null) => void;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v || null) });
  const current = options.find((o) => o.value === value);
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <label className="text-sm text-muted-foreground">{label}</label> : null}
      <DropdownMenu {...dd.menu}>
        <DropdownMenuTrigger
          className={cn(
            "flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm",
            "enabled:hover:bg-muted",
          )}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[var(--anchor-width)]">
          <DropdownMenuRadioGroup {...dd.radio} value={value ?? ""}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function KeyGroupRadio({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {KEY_GROUPS_AVAILABLE.map((kg) => {
        const selected = value === kg.value;
        return (
          <button
            type="button"
            key={kg.value}
            onClick={() => onChange(kg.value)}
            className={cn(
              "rounded-md border border-border px-2.5 py-1 text-sm active:translate-y-px",
              selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
            )}
          >
            {kg.label}
          </button>
        );
      })}
    </div>
  );
}
