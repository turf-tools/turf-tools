import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ChevronDown, Copy, Download, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { DeleteDialog, type DeleteBlocker } from "~/components/delete-dialog";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { NoActiveDataset } from "~/components/no-active-dataset";
import { Rail, useShowArchived } from "~/components/rail";
import type { Criteria } from "~/lib/filters";
import { customFieldsQuery } from "~/lib/queries/custom-fields";
import { electionsQuery } from "~/lib/queries/elections";
import { manifestQuery } from "~/lib/queries/manifest";
import { hasPermission } from "~/lib/permissions";
import { segmentCountsQuery, segmentDetailQuery, segmentsListQuery } from "~/lib/queries/segments";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { useHotkey } from "~/lib/use-hotkey";
import { cn, nextUntitledName } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

const EXPORT_CONFIRM_THRESHOLD = 100_000;

// Round to 2 significant figures for a friendlier display.
function approxCount(n: number): string {
  if (n < 1000) return n.toLocaleString();
  const factor = 10 ** (Math.floor(Math.log10(n)) - 1);
  return (Math.round(n / factor) * factor).toLocaleString();
}

export const Route = createFileRoute("/$orgSlug/segments")({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.fetchQuery(segmentsListQuery()),
      queryClient.fetchQuery(manifestQuery()),
      // Custom-field defs join the manifest in the filter catalog — prefetch
      // both so saved filter cards paint complete instead of sliding in.
      queryClient.fetchQuery(customFieldsQuery()),
      // Warm the voting-history-detail picker so opening one never flashes.
      queryClient.fetchQuery(electionsQuery()),
    ]),
  component: SegmentsLayout,
});

function SegmentsLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { orgSlug } = Route.useParams();
  const params = useParams({ strict: false }) as { segmentId?: string };
  const activeSegmentId = params.segmentId ?? null;
  const shouldFade = useFadeOnce("/segments");

  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const sortedSegments = sortByName(segments);
  const activeSegments = sortedSegments.filter((s) => !s.isArchived);
  const archivedSegments = sortedSegments.filter((s) => s.isArchived);
  const [showArchived, setShowArchived] = useShowArchived(archivedSegments.length);
  const { data: manifest } = useSuspenseQuery(manifestQuery());
  const { role } = Route.useRouteContext();
  const activeSegment = segments.find((s) => s.segmentId === activeSegmentId) ?? null;

  const goToSegment = (id: string) =>
    navigate({ to: "/$orgSlug/segments/$segmentId", params: { orgSlug, segmentId: id } });

  const downloadExport = (format: "csv" | "parquet") => {
    if (!activeSegmentId) return;
    // Content-Disposition on the /api route makes the browser download rather
    // than navigate, so the SPA stays put.
    window.location.href = `/api/web/${orgSlug}/segment-export?segmentId=${activeSegmentId}&format=${format}`;
  };

  // Split open-boolean from the value so the confirm body keeps its count
  // during the close animation instead of flashing empty.
  const [exportConfirm, setExportConfirm] = useState<{
    format: "csv" | "parquet";
    count: number;
  } | null>(null);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);

  // Fetch the live person count (a cache hit while the editor is open) to gate
  // large exports behind a confirm; small ones download straight away — the
  // browser's own download UI is the only feedback needed.
  const onExport = async (format: "csv" | "parquet") => {
    if (!activeSegmentId) return;
    try {
      const detail = await queryClient.fetchQuery(segmentDetailQuery(activeSegmentId));
      const { personCount } = await queryClient.fetchQuery(
        segmentCountsQuery((detail?.criteria ?? { steps: [] }) as Criteria),
      );
      if (personCount > EXPORT_CONFIRM_THRESHOLD) {
        setExportConfirm({ format, count: personCount });
        setExportConfirmOpen(true);
      } else {
        downloadExport(format);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't prepare the export.");
    }
  };

  const renameSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; name: string }) => client.segments.rename(input),
    onSuccess: async (_data, input) => {
      // Cancel any in-flight list fetch before patching — a response that
      // started pre-rename carries the old name and would land after the
      // patch and clobber it (the invalidate below dedupes into an
      // in-flight fetch instead of starting a fresh one).
      await queryClient.cancelQueries({ queryKey: ["segments"] });
      queryClient.setQueryData<typeof segments>(
        ["segments"],
        (old) =>
          old?.map((s) => (s.segmentId === input.segmentId ? { ...s, name: input.name } : s)) ??
          old,
      );
      queryClient.setQueryData(
        ["segment", input.segmentId],
        (old: Record<string, unknown> | null | undefined) =>
          old ? { ...old, name: input.name } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
  });

  // New segments are created immediately as "Untitled segment" (no naming step).
  const createSegment = useMutation({
    mutationFn: (input: { name: string }) => client.segments.create(input),
    onSuccess: (created) => {
      // Inject and navigate synchronously so React batches both updates
      // into one render — otherwise the new row appears unselected for a
      // frame before the URL catches up.
      queryClient.setQueryData<typeof segments>(["segments"], (old) =>
        old ? [...old, created] : [created],
      );
      queryClient.setQueryData(["segment", created.segmentId], created);
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
      return goToSegment(created.segmentId);
    },
    onError: (e) => toast.error(e.message),
  });

  const cloneSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; newName: string }) => client.segments.clone(input),
    onSuccess: (created) => {
      queryClient.setQueryData<typeof segments>(["segments"], (old) =>
        old ? [...old, created] : [created],
      );
      queryClient.setQueryData(["segment", created.segmentId], created);
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
      return goToSegment(created.segmentId);
    },
  });

  const setSegmentArchived = useMutation({
    mutationFn: (input: { segmentId: string; archived: boolean }) =>
      input.archived
        ? client.segments.archive({ segmentId: input.segmentId })
        : client.segments.unarchive({ segmentId: input.segmentId }),
    onSuccess: async (_data, input) => {
      // Cancel in-flight list fetches so a pre-mutation response can't
      // land after the patch and clobber it.
      await queryClient.cancelQueries({ queryKey: ["segments"] });
      const patch = () =>
        queryClient.setQueryData<typeof segments>(
          ["segments"],
          (old) =>
            old?.map((s) =>
              s.segmentId === input.segmentId ? { ...s, isArchived: input.archived } : s,
            ) ?? old,
        );
      if (input.archived) {
        // Leave before the cache says "archived" — a patched cache under
        // a still-selected item renders a one-frame "Unarchive" flash.
        // With a fallback, move first and patch after. On the last
        // active item the index redirect needs the patched list (else it
        // bounces back here), so patch and navigate in one synchronous
        // block — batched into a single render, like the create flows.
        setArchiveOpen(false);
        const idx = activeSegments.findIndex((s) => s.segmentId === input.segmentId);
        const fallback = activeSegments[idx - 1] ?? activeSegments[idx + 1] ?? null;
        if (fallback) {
          await goToSegment(fallback.segmentId);
          patch();
        } else {
          patch();
          await navigate({ to: "/$orgSlug/segments", params: { orgSlug } });
        }
      } else {
        patch();
      }
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (e) => toast.error(e.message),
  });

  // Archive flow: archive checks for active campaigns first and confirms
  // through the dialog when any reference this segment, then exits to a
  // neighboring active segment (or the index when none remain).
  // Snapshotted at click time so the dialog body keeps its content
  // during the close animation.
  const [archiveSnapshot, setArchiveSnapshot] = useState({ name: "", campaignCount: 0 });
  const [archiveOpen, setArchiveOpen] = useState(false);

  const archiveActiveSegment = async () => {
    if (!activeSegment || activeSegment.isArchived) return;
    const { count } = await queryClient.fetchQuery({
      queryKey: ["segments", "count-campaigns", activeSegment.segmentId],
      queryFn: () => client.segments.countCampaigns({ segmentId: activeSegment.segmentId }),
      staleTime: 0,
    });
    if (count > 0) {
      setArchiveSnapshot({ name: activeSegment.name, campaignCount: count });
      setArchiveOpen(true);
    } else {
      setSegmentArchived.mutate({ segmentId: activeSegment.segmentId, archived: true });
    }
  };

  const onConfirmArchive = () => {
    if (!activeSegmentId) return;
    setSegmentArchived.mutate({ segmentId: activeSegmentId, archived: true });
  };

  // Delete flow (archived segments only): fetch what still references the
  // segment, then confirm through the dialog — referenced segments get an
  // explanation instead of a destructive action.
  const [removeSnapshot, setRemoveSnapshot] = useState<{
    name: string;
    blockers: DeleteBlocker[];
  }>({ name: "", blockers: [] });
  const [removeOpen, setRemoveOpen] = useState(false);

  const removeSegment = useMutation({
    mutationFn: (input: { segmentId: string }) => client.segments.remove(input),
    onSuccess: async (_data, input) => {
      setRemoveOpen(false);
      await queryClient.cancelQueries({ queryKey: ["segments"] });
      // Exit to a neighbor in the visible rail (archived rows are shown
      // while one is selected), patch the row out, then let the redirect
      // land — same ordering rationale as the archive flow above.
      const visible = sortedSegments.filter((s) => s.segmentId !== input.segmentId);
      const idx = sortedSegments.findIndex((s) => s.segmentId === input.segmentId);
      const fallback = visible[idx - 1] ?? visible[idx] ?? null;
      const patch = () =>
        queryClient.setQueryData<typeof segments>(
          ["segments"],
          (old) => old?.filter((s) => s.segmentId !== input.segmentId) ?? old,
        );
      if (fallback) {
        await goToSegment(fallback.segmentId);
        patch();
      } else {
        patch();
        await navigate({ to: "/$orgSlug/segments", params: { orgSlug } });
      }
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteActiveSegment = async () => {
    if (!activeSegment?.isArchived) return;
    try {
      const { blockers } = await client.segments.removeCheck({
        segmentId: activeSegment.segmentId,
      });
      setRemoveSnapshot({ name: activeSegment.name, blockers });
      setRemoveOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't check references.");
    }
  };

  const onConfirmRemove = () => {
    if (!activeSegmentId) return;
    removeSegment.mutate({ segmentId: activeSegmentId });
  };

  // Command-Delete escalates: archive an active segment, delete an
  // archived one (behind the confirm). Command-U is the way back.
  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeSegment,
    onMatch: () =>
      void (activeSegment?.isArchived ? deleteActiveSegment() : archiveActiveSegment()),
  });
  useHotkey({
    key: "u",
    mod: true,
    enabled: !!activeSegment?.isArchived,
    onMatch: () => {
      if (activeSegmentId)
        setSegmentArchived.mutate({ segmentId: activeSegmentId, archived: false });
    },
  });

  // No active dataset → nothing to build against; block the editor behind a
  // modal pointing to Data (dismiss returns to Overview).
  if (!manifest) {
    return (
      <NoActiveDataset
        entity="segments"
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
            archivedSegments.length > 0 ? (
              <Rail.ShowArchived
                show={showArchived}
                onToggle={(next) => {
                  setShowArchived(next);
                  // Hiding archived while one is selected would leave the
                  // editor on a row absent from the rail — exit to the index.
                  if (!next && activeSegment?.isArchived)
                    void navigate({ to: "/$orgSlug/segments", params: { orgSlug } });
                }}
              />
            ) : null
          }
        >
          {(showArchived ? sortedSegments : activeSegments).map((s) => (
            <Rail.Item
              key={s.segmentId}
              label={s.name}
              active={s.segmentId === activeSegmentId}
              trailing={s.isArchived ? <Archive className="ml-2 size-4 shrink-0" /> : undefined}
              onSelect={() => void goToSegment(s.segmentId)}
              onRename={renameSegment.open}
            />
          ))}
          <Rail.New
            label="New segment"
            onClick={() =>
              createSegment.mutate({ name: nextUntitledName("Untitled segment", segments) })
            }
          />
        </Rail>

        <EditorPage>
          <EditorHeader title="Segment Editor" subtitle={activeSegment?.name}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" disabled={!activeSegment} />}>
                <Download />
                Export
                <ChevronDown className="-mr-1 size-4 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onExport("csv")}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("parquet")}>Parquet</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={renameSegment.open} disabled={!activeSegment}>
              <Pencil />
              Rename
            </Button>
            <Button variant="outline" onClick={cloneSegment.open} disabled={!activeSegment}>
              <Copy />
              Clone
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                activeSegment?.isArchived
                  ? setSegmentArchived.mutate({
                      segmentId: activeSegment.segmentId,
                      archived: false,
                    })
                  : void archiveActiveSegment()
              }
              disabled={!activeSegment}
            >
              {activeSegment?.isArchived ? <ArchiveRestore /> : <Archive />}
              {activeSegment?.isArchived ? "Unarchive" : "Archive"}
            </Button>
            {activeSegment?.isArchived ? (
              <Button variant="outline" onClick={() => void deleteActiveSegment()}>
                <Trash2 />
                Delete
              </Button>
            ) : null}
          </EditorHeader>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </EditorPage>
      </div>

      <Dialog
        open={exportConfirmOpen}
        onOpenChange={(next) => {
          if (!next) setExportConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Export a large segment?</DialogTitle>
          <DialogDescription>
            Please confirm your export of{" "}
            <span className="font-bold text-foreground">
              ~{exportConfirm ? approxCount(exportConfirm.count) : ""}
            </span>{" "}
            people. It will begin downloading a large file.
          </DialogDescription>
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              onClick={() => {
                if (exportConfirm) downloadExport(exportConfirm.format);
                setExportConfirmOpen(false);
              }}
            >
              <Download />
              Export
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SaveAsDialog
        open={cloneSegment.isOpen}
        onOpenChange={cloneSegment.onOpenChange}
        defaultName={activeSegment ? `${activeSegment.name} (copy)` : ""}
        pending={cloneSegment.isPending}
        error={cloneSegment.error}
        onSubmit={(newName) => {
          if (!activeSegmentId) return;
          cloneSegment.mutate({ segmentId: activeSegmentId, newName });
        }}
      />

      <RenameDialog
        open={renameSegment.isOpen}
        onOpenChange={renameSegment.onOpenChange}
        currentName={activeSegment?.name ?? ""}
        pending={renameSegment.isPending}
        error={renameSegment.error}
        onSubmit={(name) => {
          if (!activeSegmentId) return;
          if (name === activeSegment?.name) {
            renameSegment.close();
            return;
          }
          renameSegment.mutate({ segmentId: activeSegmentId, name });
        }}
      />

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={(next) => {
          if (setSegmentArchived.isPending) return;
          setArchiveOpen(next);
        }}
        segmentName={archiveSnapshot.name}
        campaignCount={archiveSnapshot.campaignCount}
        pending={setSegmentArchived.isPending}
        onConfirm={onConfirmArchive}
      />

      <DeleteDialog
        open={removeOpen}
        onOpenChange={(next) => {
          if (removeSegment.isPending) return;
          setRemoveOpen(next);
        }}
        entity="segment"
        name={removeSnapshot.name}
        blockers={removeSnapshot.blockers}
        pending={removeSegment.isPending}
        onConfirm={onConfirmRemove}
      />
    </>
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
        <DialogTitle>Clone segment</DialogTitle>
        <DialogDescription>
          Creates a copy of the current segment, including its query.
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
        <DialogTitle>Rename segment</DialogTitle>
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

// Confirm gate shown only when active campaigns reference the segment —
// an unreferenced segment archives without ceremony.
function ArchiveDialog({
  open,
  onOpenChange,
  segmentName,
  campaignCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segmentName: string;
  campaignCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  useConfirmHotkey({ open, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Archive segment?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{segmentName}</span> is used by{" "}
          <span className="font-bold text-foreground">{campaignCount}</span> active campaign
          {campaignCount === 1 ? "" : "s"}. The campaigns keep working but the segment will be
          hidden. You can unarchive it anytime.
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={onConfirm} loading={pending}>
            <Archive />
            Archive segment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
