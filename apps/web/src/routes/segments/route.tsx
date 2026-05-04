import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { EditorHeader } from "~/components/editor-header";
import { EditorPage } from "~/components/editor-page";
import { Input } from "~/components/input";
import { Rail } from "~/components/rail";
import { segmentsListQuery } from "~/lib/queries/segments";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

function sortByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

export const Route = createFileRoute("/segments")({
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(segmentsListQuery()),
  component: SegmentsLayout,
});

function SegmentsLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { segmentId?: string };
  const activeSegmentId = params.segmentId ?? null;
  const shouldFade = useFadeOnce("/segments");

  const { data: segments } = useSuspenseQuery(segmentsListQuery());
  const sortedSegments = sortByName(segments);
  const activeSegment = segments.find((s) => s.segmentId === activeSegmentId) ?? null;

  const goToSegment = (id: string) =>
    navigate({ to: "/segments/$segmentId", params: { segmentId: id } });

  const renameSegment = useDialogMutation({
    mutationFn: (input: { segmentId: string; name: string }) => client.segments.rename(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["segments"] }),
  });

  const createSegment = useDialogMutation({
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
          await navigate({ to: "/segments" });
        }
      },
    });
  };

  return (
    <>
      <div
        className={cn(
          "flex h-[calc(100vh-3.5rem)]",
          shouldFade && "animate-in fade-in duration-100",
        )}
      >
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
          <Rail.New label="New segment" onClick={createSegment.open} />
        </Rail>

        <EditorPage>
          <EditorHeader title="Segment Editor" subtitle={activeSegment?.name}>
            <Button variant="outline" onClick={renameSegment.open} disabled={!activeSegment}>
              <Pencil />
              Rename
            </Button>
            <Button variant="outline" onClick={cloneSegment.open} disabled={!activeSegment}>
              <Copy />
              Duplicate
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

      <CreateSegmentDialog
        open={createSegment.isOpen}
        onOpenChange={createSegment.onOpenChange}
        pending={createSegment.isPending}
        error={createSegment.error}
        onSubmit={(name) => createSegment.mutate({ name })}
      />

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

function CreateSegmentDialog({
  open,
  onOpenChange,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const valid = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Create new segment</DialogTitle>
        <DialogDescription>
          A segment is a named query over people. Start with a name and add filters in the editor.
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
              placeholder="Enter a name..."
              disabled={pending}
            />
          </div>
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
        <DialogTitle>Duplicate segment</DialogTitle>
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
        <DialogTitle>Rename segment</DialogTitle>
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
