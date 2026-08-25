import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { notify } from "~/lib/notify";
import { Button } from "~/components/button";
import { DialogError } from "~/components/callout";
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
import { DeleteDialog, type DeleteBlocker } from "~/components/delete-dialog";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { NoActiveDataset } from "~/components/no-active-dataset";
import { Rail, useShowArchived } from "~/components/rail";
import {
  campaignKeyCountsQuery,
  campaignPointsQuery,
  campaignsListQuery,
  type KeyFilter,
} from "~/lib/queries/campaigns";
import { manifestQuery } from "~/lib/queries/manifest";
import { scriptsListQuery } from "~/lib/queries/scripts";
import { segmentsListQuery } from "~/lib/queries/segments";
import { hasPermission } from "~/lib/permissions";
import { turfStatsForCampaignQuery } from "~/lib/queries/turfs";
import {
  zoneGroupsQuery,
  zonePerimetersQuery,
  zonePerimetersVersion,
  zonesQuery,
} from "~/lib/queries/zones";
import { settleMutation } from "~/lib/settle";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
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

export const Route = createFileRoute("/$orgSlug/campaigns")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.fetchQuery(campaignsListQuery()),
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(zoneGroupsQuery()),
      queryClient.fetchQuery(scriptsListQuery()),
      queryClient.fetchQuery(manifestQuery()),
    ]);
  },
  component: CampaignsLayout,
});

function CampaignsLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { orgSlug } = Route.useParams();
  const params = useParams({ strict: false }) as { campaignId?: string };
  const activeCampaignId = params.campaignId ?? null;
  const shouldFade = useFadeOnce("/campaigns");

  // Cutter takes the entire content area; skip the editor header in that
  // case. Reads the *committed* match (not the eager pathname) so the
  // header doesn't flicker during the cutter's loader run.
  const childMatches = useChildMatches();
  const isCut = childMatches.some(
    (m) => m.routeId.endsWith("/cut/$zoneId") || m.routeId.endsWith("/cut/"),
  );

  const { data: campaigns } = useSuspenseQuery(campaignsListQuery());
  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const { data: zoneGroups } = useSuspenseQuery(zoneGroupsQuery());
  const { data: scripts } = useSuspenseQuery(scriptsListQuery());
  const { data: manifest } = useSuspenseQuery(manifestQuery());
  const { role } = Route.useRouteContext();

  const sortedCampaigns = sortByName(campaigns);
  const activeCampaigns = sortedCampaigns.filter((c) => !c.isArchived);
  const archivedCampaigns = sortedCampaigns.filter((c) => c.isArchived);
  const [showArchived, setShowArchived] = useShowArchived(archivedCampaigns.length);
  const activeCampaign = campaigns.find((c) => c.campaignId === activeCampaignId) ?? null;

  // Picker options exclude archived rows, except the one a campaign is
  // already bound to — hiding that would blank the trigger label.
  const segmentOptions = (boundId?: string | null) =>
    segments
      .filter((s) => !s.isArchived || s.segmentId === boundId)
      .map((s) => ({ value: s.segmentId, label: s.name, archived: s.isArchived }));
  const zoneGroupOptions = (boundId?: string | null) =>
    zoneGroups
      .filter((g) => !g.isArchived || g.zoneGroupId === boundId)
      .map((g) => ({ value: g.zoneGroupId, label: g.name, archived: g.isArchived }));
  const scriptOptions = (boundId?: string | null) =>
    scripts
      .filter((s) => !s.isArchived || s.scriptId === boundId)
      .map((s) => ({ value: s.scriptId, label: s.name, archived: s.isArchived }));
  // Configure / rename / duplicate need the bound segment + zone group
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
    navigate({ to: "/$orgSlug/campaigns/$campaignId", params: { orgSlug, campaignId: id } });

  // Mirror of the editor-route loader's prefetch logic — used by the
  // create/clone flows to warm caches against the new campaign's
  // bindings before the navigate, so the body's queries cache-hit.
  // Segment criteria comes from the segments list cache (already loaded
  // above) — same lookup pattern the campaign view uses.
  const prefetchCampaignViewData = async (target: {
    campaignId: string;
    segmentId: string | null;
    zoneGroupId: string | null;
  }) => {
    const zgs = await queryClient.fetchQuery(zoneGroupsQuery());
    const nextZoneGroup = zgs.find((g) => g.zoneGroupId === target.zoneGroupId) ?? null;
    const nextSegment = target.segmentId
      ? (segments.find((s) => s.segmentId === target.segmentId) ?? null)
      : null;
    const nextCriteria = nextSegment?.criteria ?? null;
    const nextZones = target.zoneGroupId
      ? await queryClient.fetchQuery(zonesQuery(target.zoneGroupId))
      : undefined;
    const nextKeyFilter = deriveKeyFilter(nextZoneGroup, nextZones);
    await Promise.all([
      queryClient.prefetchQuery(turfStatsForCampaignQuery(target.campaignId)),
      nextZoneGroup
        ? queryClient.prefetchQuery(
            zonePerimetersQuery(
              [nextZoneGroup.zoneGroupId],
              zonePerimetersVersion(manifest?.versionId, nextZones),
            ),
          )
        : Promise.resolve(),
      nextCriteria && nextKeyFilter
        ? queryClient.prefetchQuery(campaignPointsQuery(nextCriteria, nextKeyFilter, segments))
        : Promise.resolve(),
      nextCriteria && nextKeyFilter
        ? queryClient.prefetchQuery(
            campaignKeyCountsQuery(
              nextCriteria,
              nextKeyFilter.keyGroup,
              nextKeyFilter.keys,
              segments,
            ),
          )
        : Promise.resolve(),
    ]);
  };

  const renameCampaign = useDialogMutation({
    mutationFn: (input: { campaignId: string; name: string }) => client.campaigns.rename(input),
    onSuccess: (_data, input) =>
      settleMutation(queryClient, {
        keys: [["campaigns"], ["campaign", input.campaignId]],
        patch: () => {
          queryClient.setQueryData<typeof campaigns>(
            ["campaigns"],
            (old) =>
              old?.map((c) =>
                c.campaignId === input.campaignId ? { ...c, name: input.name } : c,
              ) ?? old,
          );
          queryClient.setQueryData(
            ["campaign", input.campaignId],
            (old: Record<string, unknown> | null | undefined) =>
              old ? { ...old, name: input.name } : old,
          );
        },
      }),
  });

  // Wrapping zoneGroups.createWithDefaultZone + campaigns.create in one
  // mutation so the dialog's pending/error UX is coherent across both paths.
  const createCampaign = useDialogMutation({
    mutationFn: (input: {
      name: string;
      segmentId: string;
      scriptId: string;
      zoneGroupId: string | null;
    }) => {
      return client.campaigns.create({
        name: input.name,
        segmentId: input.segmentId,
        scriptId: input.scriptId,
        zoneGroupId: input.zoneGroupId,
      });
    },
    onSuccess: (created) =>
      settleMutation(queryClient, {
        keys: [["campaigns"], ["campaign", created.campaignId]],
        // Inject and navigate in one synchronous block so React batches both
        // updates — otherwise the new row renders unselected for a frame.
        patch: () => {
          queryClient.setQueryData<typeof campaigns>(["campaigns"], (old) =>
            old ? [...old, created] : [created],
          );
          queryClient.setQueryData(["campaign", created.campaignId], created);
          return goToCampaign(created.campaignId);
        },
      }),
  });

  const cloneCampaign = useDialogMutation({
    mutationFn: (input: { campaignId: string; newName: string }) => client.campaigns.clone(input),
    onSuccess: (created) =>
      settleMutation(queryClient, {
        keys: [["campaigns"], ["campaign", created.campaignId]],
        patch: () => {
          queryClient.setQueryData<typeof campaigns>(["campaigns"], (old) =>
            old ? [...old, created] : [created],
          );
          queryClient.setQueryData(["campaign", created.campaignId], created);
          return goToCampaign(created.campaignId);
        },
      }),
  });

  const setCampaignArchived = useMutation({
    mutationFn: (input: { campaignId: string; archived: boolean }) =>
      input.archived
        ? client.campaigns.archive({ campaignId: input.campaignId })
        : client.campaigns.unarchive({ campaignId: input.campaignId }),
    onSuccess: (_data, input) =>
      settleMutation(queryClient, {
        // Archived state changes which turfs the board shows.
        keys: [["campaigns"], ["turfs"]],
        patch: async () => {
          const patch = () =>
            queryClient.setQueryData<typeof campaigns>(
              ["campaigns"],
              (old) =>
                old?.map((c) =>
                  c.campaignId === input.campaignId ? { ...c, isArchived: input.archived } : c,
                ) ?? old,
            );
          if (input.archived) {
            // Leave before the cache says "archived" — a patched cache under
            // a still-selected item renders a one-frame "Unarchive" flash.
            // With a fallback, move first and patch after. On the last
            // active item the index redirect needs the patched list (else it
            // bounces back here), so patch and navigate in one synchronous
            // block — batched into a single render, like the create flows.
            const idx = activeCampaigns.findIndex((c) => c.campaignId === input.campaignId);
            const fallback = activeCampaigns[idx - 1] ?? activeCampaigns[idx + 1] ?? null;
            if (fallback) {
              await goToCampaign(fallback.campaignId);
              patch();
            } else {
              patch();
              await navigate({ to: "/$orgSlug/campaigns", params: { orgSlug } });
            }
          } else {
            patch();
          }
        },
      }),
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
      // The dialog has already closed by the time the write settles, so a
      // silent rollback reads as the app changing its mind — say so.
      notify.error("Couldn't save the campaign configuration. Please try again.");
    },
    // Settle-with-invalidation: the campaigns LIST also carries segmentId /
    // zoneGroupId and seeds the configure dialog, so both keys must re-sync.
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", input.campaignId] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  // A campaign can't exist without a segment and a script — gate the create
  // dialog behind both so it never opens in a state where it can't succeed.
  const needSegment = segments.every((s) => s.isArchived);
  const needScript = scripts.every((s) => s.isArchived);
  const [prereqsOpen, setPrereqsOpen] = useState(false);

  const [configOpen, setConfigOpen] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  // Pending patch + draft count snapshotted at Save-click time, used by
  // the zone-change confirm dialog. Non-null state == confirm is open.
  const [pendingZoneChange, setPendingZoneChange] = useState<{
    patch: { segmentId: string | null; zoneGroupId: string | null; scriptId: string | null };
    draftCount: number;
  } | null>(null);
  // Archiving is the terminal act for a campaign (no warning dialog) —
  // exits to a neighboring active campaign, or the index when none
  // remain. Unarchive stays put.
  const archiveActiveCampaign = () => {
    if (!activeCampaign || activeCampaign.isArchived) return;
    setCampaignArchived.mutate({ campaignId: activeCampaign.campaignId, archived: true });
  };

  // Delete flow (archived campaigns only): fetch what still references
  // the campaign, then confirm through the dialog — campaigns with turfs
  // get an explanation instead of a destructive action.
  const [removeSnapshot, setRemoveSnapshot] = useState<{
    name: string;
    blockers: DeleteBlocker[];
  }>({ name: "", blockers: [] });
  const [removeOpen, setRemoveOpen] = useState(false);

  const removeCampaign = useMutation({
    mutationFn: (input: { campaignId: string }) => client.campaigns.remove(input),
    onSuccess: (_data, input) => {
      setRemoveOpen(false);
      return settleMutation(queryClient, {
        keys: [["campaigns"]],
        evict: [
          ["campaign", input.campaignId],
          ["turf-stats", input.campaignId],
          ["turf-drafts", input.campaignId],
        ],
        patch: async () => {
          // Exit to a neighbor in the visible rail (archived rows are shown
          // while one is selected), patch the row out, then let the redirect
          // land — same ordering rationale as the archive flow above.
          const visible = sortedCampaigns.filter((c) => c.campaignId !== input.campaignId);
          const idx = sortedCampaigns.findIndex((c) => c.campaignId === input.campaignId);
          const fallback = visible[idx - 1] ?? visible[idx] ?? null;
          const patch = () =>
            queryClient.setQueryData<typeof campaigns>(
              ["campaigns"],
              (old) => old?.filter((c) => c.campaignId !== input.campaignId) ?? old,
            );
          if (fallback) {
            await goToCampaign(fallback.campaignId);
            patch();
          } else {
            patch();
            await navigate({ to: "/$orgSlug/campaigns", params: { orgSlug } });
          }
        },
      });
    },
  });

  const deleteActiveCampaign = async () => {
    if (!activeCampaign?.isArchived) return;
    try {
      const { blockers } = await client.campaigns.removeCheck({
        campaignId: activeCampaign.campaignId,
      });
      setRemoveSnapshot({ name: activeCampaign.name, blockers });
      setRemoveOpen(true);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "Couldn't check references.");
    }
  };

  const onConfirmRemove = () => {
    if (!activeCampaignId) return;
    removeCampaign.mutate({ campaignId: activeCampaignId });
  };

  // Disabled in the cutter so Mod-Delete there isn't claimed by the
  // campaign-archive shortcut (the cutter has its own Delete behavior).
  // Command-Delete escalates: archive an active campaign, delete an
  // archived one (behind the confirm). Command-U is the way back.
  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeCampaign && !isCut,
    onMatch: () =>
      void (activeCampaign?.isArchived ? deleteActiveCampaign() : archiveActiveCampaign()),
  });
  useHotkey({
    key: "u",
    mod: true,
    enabled: !!activeCampaign?.isArchived && !isCut,
    onMatch: () => {
      if (activeCampaignId)
        setCampaignArchived.mutate({ campaignId: activeCampaignId, archived: false });
    },
  });

  // Actual save path — clears drafts when the zone group changed, then
  // warms caches against the new bindings before firing the optimistic
  // detail update. Called directly when no drafts are at risk, or via
  // the confirm dialog when there are.
  const commitConfigure = async (
    patch: {
      segmentId: string | null;
      zoneGroupId: string | null;
      scriptId: string | null;
    },
    opts: { clearDrafts: boolean },
  ) => {
    if (!activeCampaignId) return;
    setConfigSaving(true);
    try {
      if (opts.clearDrafts) {
        await client.turfDrafts.clearForCampaign({ campaignId: activeCampaignId });
        // Remove rather than invalidate — we know the drafts no longer
        // exist server-side, so any cached row would be wrong, and we'd
        // rather force a clean refetch on next access than risk a render
        // with stale cache that's been marked-but-not-yet-refetched.
        queryClient.removeQueries({ queryKey: ["turf-drafts", activeCampaignId] });
        void queryClient.invalidateQueries({ queryKey: ["turf-stats", activeCampaignId] });
      }
      // Fire-and-forget the cache-warming prefetch — awaiting it pushes
      // the total dialog-locked time past the spinner threshold (~100ms)
      // for no UX benefit, since the optimistic campaign update below is
      // what actually drives the view's rebind.
      void prefetchCampaignViewData({
        campaignId: activeCampaignId,
        segmentId: patch.segmentId,
        zoneGroupId: patch.zoneGroupId,
      });
      updateCampaignMutation.mutate({ campaignId: activeCampaignId, ...patch });
      setConfigOpen(false);
      setPendingZoneChange(null);
    } finally {
      setConfigSaving(false);
    }
  };

  const saveConfigure = async (patch: {
    segmentId: string | null;
    zoneGroupId: string | null;
    scriptId: string | null;
  }) => {
    if (!activeCampaignId) return;
    const zoneGroupChanged = patch.zoneGroupId !== (campaign?.zoneGroupId ?? null);
    if (!zoneGroupChanged) {
      await commitConfigure(patch, { clearDrafts: false });
      return;
    }
    // Read draft count from the turf-stats cache (already warm when
    // the editor is open). Trust the cache for the user-facing N; the
    // server-side clear runs unconditionally on a zone change so any
    // drift can't leave orphaned drafts behind.
    const stats = queryClient.getQueryData<
      Record<string, { drafts: number; published: number; active: number }>
    >(turfStatsForCampaignQuery(activeCampaignId).queryKey);
    const draftCount = stats ? Object.values(stats).reduce((a, b) => a + b.drafts, 0) : 0;
    if (draftCount === 0) {
      await commitConfigure(patch, { clearDrafts: true });
      return;
    }
    setPendingZoneChange({ patch, draftCount });
  };

  // No active dataset → nothing to build against; block the editor behind a
  // modal pointing to Data (dismiss returns to Overview).
  if (!manifest) {
    return (
      <NoActiveDataset
        entity="campaigns"
        orgSlug={orgSlug}
        canManage={hasPermission(role, "datasets.manage")}
      />
    );
  }

  return (
    <>
      <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
        <Rail
          footer={
            archivedCampaigns.length > 0 ? (
              <Rail.ShowArchived
                show={showArchived}
                onToggle={(next) => {
                  setShowArchived(next);
                  // Hiding archived while one is selected would leave the
                  // editor on a row absent from the rail — exit to the index.
                  if (!next && activeCampaign?.isArchived)
                    void navigate({ to: "/$orgSlug/campaigns", params: { orgSlug } });
                }}
              />
            ) : null
          }
        >
          {(showArchived ? sortedCampaigns : activeCampaigns).map((c) => (
            <Rail.Item
              key={c.campaignId}
              label={c.name}
              active={c.campaignId === activeCampaignId}
              trailing={c.isArchived ? <Archive className="ml-2 size-4 shrink-0" /> : undefined}
              onSelect={() => void goToCampaign(c.campaignId)}
              onRename={renameCampaign.open}
            />
          ))}
          <Rail.New
            label="New campaign"
            onClick={needSegment || needScript ? () => setPrereqsOpen(true) : createCampaign.open}
          />
        </Rail>

        <EditorPage>
          {!isCut ? (
            <EditorHeader title="Campaign Editor" subtitle={activeCampaign?.name}>
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
                Clone
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  activeCampaign?.isArchived
                    ? setCampaignArchived.mutate({
                        campaignId: activeCampaign.campaignId,
                        archived: false,
                      })
                    : archiveActiveCampaign()
                }
                disabled={!activeCampaign}
              >
                {activeCampaign?.isArchived ? <ArchiveRestore /> : <Archive />}
                {activeCampaign?.isArchived ? "Unarchive" : "Archive"}
              </Button>
              {activeCampaign?.isArchived ? (
                <Button variant="outline" onClick={() => void deleteActiveCampaign()}>
                  <Trash2 />
                  Delete
                </Button>
              ) : null}
            </EditorHeader>
          ) : null}
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </EditorPage>
      </div>

      <PrereqsDialog
        open={prereqsOpen}
        onOpenChange={setPrereqsOpen}
        orgSlug={orgSlug}
        needSegment={needSegment}
        needScript={needScript}
      />

      <CreateCampaignDialog
        open={createCampaign.isOpen}
        onOpenChange={createCampaign.onOpenChange}
        pending={createCampaign.isPending}
        error={createCampaign.error}
        segmentOptions={segmentOptions()}
        zoneGroupOptions={zoneGroupOptions()}
        scriptOptions={scriptOptions()}
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

      <ConfigureDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        currentSegmentId={campaign?.segmentId ?? null}
        currentZoneGroupId={campaign?.zoneGroupId ?? null}
        currentScriptId={campaign?.scriptId ?? null}
        segmentOptions={segmentOptions(campaign?.segmentId)}
        zoneGroupOptions={zoneGroupOptions(campaign?.zoneGroupId)}
        scriptOptions={scriptOptions(campaign?.scriptId)}
        pending={configSaving}
        onSubmit={(patch) => void saveConfigure(patch)}
      />

      <ConfirmZoneChangeDialog
        open={pendingZoneChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingZoneChange(null);
        }}
        draftCount={pendingZoneChange?.draftCount ?? 0}
        pending={configSaving}
        onConfirm={() => {
          if (!pendingZoneChange) return;
          void commitConfigure(pendingZoneChange.patch, { clearDrafts: true });
        }}
      />

      <DeleteDialog
        open={removeOpen}
        onOpenChange={(next) => {
          if (removeCampaign.isPending) return;
          setRemoveOpen(next);
        }}
        entity="campaign"
        name={removeSnapshot.name}
        blockers={removeSnapshot.blockers}
        pending={removeCampaign.isPending}
        onConfirm={onConfirmRemove}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialog components
// ---------------------------------------------------------------------------

// `archived` marks the one archived entity a campaign is already bound
// to (archived entities are otherwise excluded from options) — rendered
// as a muted suffix, never folded into the name itself.
type SelectOption = { value: string; label: string; archived?: boolean };

// Shown in place of the create dialog when the org has no segments and/or no
// scripts — a campaign requires one of each, so the form couldn't succeed.
// One "Go to" button per missing prerequisite.
function PrereqsDialog({
  open,
  onOpenChange,
  orgSlug,
  needSegment,
  needScript,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  needSegment: boolean;
  needScript: boolean;
}) {
  const missing =
    needSegment && needScript ? "segments or scripts" : needSegment ? "segments" : "scripts";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>No {missing} yet</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people) and a script (questions). You don't have any{" "}
          {missing} yet so you'll need to create {needSegment && needScript ? "one of each" : "one"}{" "}
          first.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          {needSegment ? (
            <Button render={<Link to="/$orgSlug/segments" params={{ orgSlug }} />}>
              Go to Segments
            </Button>
          ) : null}
          {needScript ? (
            <Button render={<Link to="/$orgSlug/scripts" params={{ orgSlug }} />}>
              Go to Scripts
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Sentinel for the "construct fresh zone group from key group" path —
// sits alongside real zone-group ids in the create-dialog dropdown.

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
  }) => void;
}) {
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [zonesValue, setZonesValue] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setSegmentId(null);
      setScriptId(null);
      setZonesValue(null);
    }
  }, [open]);

  // Zones is optional — a campaign with no zone group cuts turfs against
  // the whole segment.
  const valid = name.trim().length > 0 && segmentId !== null && scriptId !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new campaign</DialogTitle>
        <DialogDescription>
          A campaign combines a segment (people) and a script (questions). Optionally pick a group
          of zones to subdivide the segment for turf cutting. Choices can be edited later via
          Configure.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit({
              name: name.trim(),
              segmentId: segmentId!,
              scriptId: scriptId!,
              zoneGroupId: zonesValue,
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
            options={zoneGroupOptions}
            onChange={setZonesValue}
            noneLabel="None (full segment)"
          />
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
        <DialogTitle>Clone campaign</DialogTitle>
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
              Clone
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
  const trimmed = name.trim();
  const dirty = trimmed !== currentName;
  const valid = trimmed.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Rename campaign</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !dirty || pending) return;
            onSubmit(trimmed);
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
            <Button type="submit" disabled={!valid || !dirty} loading={pending}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmZoneChangeDialog({
  open,
  onOpenChange,
  draftCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  useConfirmHotkey({ open, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Change zones?</DialogTitle>
        <DialogDescription>
          Changing the zone group will discard{" "}
          <span className="font-bold text-foreground">{draftCount}</span> draft turf
          {draftCount === 1 ? "" : "s"}. Published turfs are unaffected.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onConfirm} loading={pending}>
            Discard drafts and save
          </Button>
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
            noneLabel="None (full segment)"
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
  noneLabel,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string | null) => void;
  // When set, renders an explicit "none" item at the top of the list
  // that commits `null`. The trigger displays this label when value is
  // null (instead of the placeholder).
  noneLabel?: string;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v || null) });
  const current = options.find((o) => o.value === value);
  const triggerLabel = current
    ? `${current.label}${current.archived ? " (Archived)" : ""}`
    : value === null && noneLabel
      ? noneLabel
      : placeholder;
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
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[var(--anchor-width)]">
          <DropdownMenuRadioGroup {...dd.radio} value={value ?? ""}>
            {noneLabel ? <DropdownMenuRadioItem value="">{noneLabel}</DropdownMenuRadioItem> : null}
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
                {o.archived ? " (Archived)" : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
