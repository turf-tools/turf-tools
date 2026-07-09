import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDown, Copy, Download, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { Rail } from "~/components/rail";
import type { Criteria } from "~/lib/filters";
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
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(segmentsListQuery()),
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
    onSuccess: (_data, input) => {
      queryClient.setQueryData<typeof segments>(
        ["segments"],
        (old) =>
          old?.map((s) => (s.segmentId === input.segmentId ? { ...s, name: input.name } : s)) ??
          old,
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

  const deleteSegment = useDialogMutation({
    mutationFn: (segmentId: string) => client.segments.remove({ segmentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
  });

  // Snapshotted at click time so the dialog body keeps showing the
  // just-deleted name during its close animation, even after the URL
  // has reactively swapped to the fallback segment.
  const [deleteSnapshot, setDeleteSnapshot] = useState({ name: "", campaignCount: 0 });

  const onConfirmDelete = () => {
    if (!activeSegmentId) return;
    const idx = sortedSegments.findIndex((s) => s.segmentId === activeSegmentId);
    const fallback = sortedSegments[idx - 1] ?? sortedSegments[idx + 1] ?? null;
    deleteSegment.mutate(activeSegmentId, {
      onSuccess: async () => {
        if (fallback) {
          await goToSegment(fallback.segmentId);
        } else {
          await navigate({ to: "/$orgSlug/segments", params: { orgSlug } });
        }
      },
    });
  };

  useHotkey({
    key: ["Delete", "Backspace"],
    mod: true,
    enabled: !!activeSegmentId,
    onMatch: () => {
      if (!activeSegmentId) return;
      void (async () => {
        const { count } = await queryClient.fetchQuery({
          queryKey: ["segments", "count-campaigns", activeSegmentId],
          queryFn: () => client.segments.countCampaigns({ segmentId: activeSegmentId }),
          staleTime: 0,
        });
        setDeleteSnapshot({ name: activeSegment?.name ?? "", campaignCount: count });
        deleteSegment.open();
      })();
    },
  });

  return (
    <>
      <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
        <Rail>
          {sortedSegments.map((s) => (
            <Rail.Item
              key={s.segmentId}
              label={s.name}
              active={s.segmentId === activeSegmentId}
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
              onClick={async () => {
                if (!activeSegmentId) return;
                const { count } = await queryClient.fetchQuery({
                  queryKey: ["segments", "count-campaigns", activeSegmentId],
                  queryFn: () => client.segments.countCampaigns({ segmentId: activeSegmentId }),
                  staleTime: 0,
                });
                setDeleteSnapshot({ name: activeSegment?.name ?? "", campaignCount: count });
                deleteSegment.open();
              }}
              disabled={!activeSegment}
            >
              <Trash2 />
              Delete
            </Button>
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

      <DeleteDialog
        open={deleteSegment.isOpen}
        onOpenChange={deleteSegment.onOpenChange}
        segmentName={deleteSnapshot.name}
        campaignCount={deleteSnapshot.campaignCount}
        pending={deleteSegment.isPending}
        error={deleteSegment.error}
        onConfirm={onConfirmDelete}
      />
    </>
  );
}

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

function DeleteDialog({
  open,
  onOpenChange,
  segmentName,
  campaignCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segmentName: string;
  campaignCount: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const inUse = campaignCount > 0;
  useConfirmHotkey({ open: open && !inUse, disabled: pending, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {!inUse && <DialogTitle>Delete segment?</DialogTitle>}
        <DialogDescription>
          {inUse ? (
            <>
              Can't delete <span className="font-medium text-foreground">{segmentName}</span>{" "}
              because it is used by{" "}
              <span className="font-bold text-foreground">{campaignCount}</span> campaign
              {campaignCount === 1 ? "" : "s"}. Detach or delete those campaigns first, then try
              again.
            </>
          ) : (
            <>
              Permanently deletes <span className="font-medium text-foreground">{segmentName}</span>
              . This can't be undone.
            </>
          )}
        </DialogDescription>
        <DialogError error={error} />
        <div className="mt-2 flex justify-end gap-2">
          {inUse ? (
            <DialogClose render={<Button variant="outline" />}>OK</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                Delete segment
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
