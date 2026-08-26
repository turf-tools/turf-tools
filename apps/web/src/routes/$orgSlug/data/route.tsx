import { Icon } from "~/components/icon";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { Callout, DialogError } from "~/components/callout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { Input } from "~/components/input";
import { Rail, useShowArchived } from "~/components/rail";
import { AVAILABLE_IMPORTERS } from "~/lib/importers";
import { hasPermission } from "~/lib/permissions";
import { datasetsListQuery } from "~/lib/queries/datasets";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/data")({
  beforeLoad: ({ context, params }) => {
    if (!hasPermission(context.role, "datasets.manage")) {
      throw redirect({ to: "/$orgSlug/overview", params: { orgSlug: params.orgSlug } });
    }
  },
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(datasetsListQuery()),
  component: DataLayout,
});

function DataLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { orgSlug } = Route.useParams();
  const params = useParams({ strict: false }) as { datasetId?: string };
  const activeDatasetId = params.datasetId ?? null;
  const shouldFade = useFadeOnce("/data");

  const { data: versionRows } = useSuspenseQuery({
    ...datasetsListQuery(),
    // Poll while any version is importing so rows advance to Ready on their own.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "importing") ? 3000 : false),
  });

  // One rail entry per dataset; the list endpoint returns flat version rows
  // (already name-sorted). "Archived" is derived, not stored: a dataset
  // with no unarchived versions has nothing to activate or show, so it
  // hides behind the footer toggle until a version is unarchived (or a
  // new one imported).
  const datasets = useMemo(() => {
    const byId = new Map<
      string,
      { datasetId: string; name: string; isActive: boolean; allArchived: boolean }
    >();
    for (const r of versionRows) {
      const g = byId.get(r.datasetId) ?? {
        datasetId: r.datasetId,
        name: r.name,
        isActive: false,
        allArchived: true,
      };
      g.isActive ||= r.isActive;
      g.allArchived &&= r.isArchived;
      byId.set(r.datasetId, g);
    }
    return [...byId.values()];
  }, [versionRows]);
  const archivedCount = datasets.filter((d) => d.allArchived).length;
  const [showArchived, setShowArchived] = useShowArchived(archivedCount);
  const visibleDatasets = showArchived ? datasets : datasets.filter((d) => !d.allArchived);

  const goToDataset = (datasetId: string) =>
    navigate({ to: "/$orgSlug/data/$datasetId", params: { orgSlug, datasetId } });

  const [createOpen, setCreateOpen] = useState(false);

  const renameDataset = useDatasetRename();
  const activeDataset = datasets.find((d) => d.datasetId === activeDatasetId) ?? null;

  return (
    <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
      <Rail
        footer={
          archivedCount > 0 ? (
            <Rail.ShowArchived
              show={showArchived}
              onToggle={(next) => {
                setShowArchived(next);
                // Hiding archived while one is selected would leave the page
                // on a dataset absent from the rail — exit to the index.
                if (!next && activeDataset?.allArchived)
                  void navigate({ to: "/$orgSlug/data", params: { orgSlug } });
              }}
            />
          ) : null
        }
      >
        {visibleDatasets.map((d) => (
          <Rail.Item
            key={d.datasetId}
            label={d.name}
            active={d.datasetId === activeDatasetId}
            trailing={
              d.isActive ? (
                <Icon name="check" className="ml-2 size-4 shrink-0 [stroke-width:2.25]" />
              ) : d.allArchived ? (
                <Icon name="archive" className="ml-2 size-4 shrink-0" />
              ) : undefined
            }
            onSelect={() => void goToDataset(d.datasetId)}
            onRename={renameDataset.open}
          />
        ))}
        <Rail.New label="Import dataset" onClick={() => setCreateOpen(true)} />
      </Rail>

      <RenameDatasetDialog
        open={renameDataset.isOpen}
        onOpenChange={renameDataset.onOpenChange}
        currentName={activeDataset?.name ?? ""}
        pending={renameDataset.isPending}
        error={renameDataset.error}
        onSubmit={(name) => {
          if (!activeDatasetId) return;
          renameDataset.mutate({ datasetId: activeDatasetId, name });
        }}
      />

      <CreateDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        takenNames={datasets.map((d) => d.name)}
        onCreated={(datasetId) => {
          void queryClient.invalidateQueries({ queryKey: ["datasets"] });
          void goToDataset(datasetId);
        }}
      />

      <Outlet />
    </div>
  );
}

// Rename with the shared list-cache patch. Exported (with the dialog)
// so the dataset page's header button and the rail's double-click share
// one implementation.
export function useDatasetRename() {
  const queryClient = useQueryClient();
  return useDialogMutation({
    mutationFn: (input: { datasetId: string; name: string }) => client.datasets.rename(input),
    onSuccess: async (_data, input) => {
      // Cancel in-flight list fetches so a pre-rename response can't
      // land after the patch and clobber it.
      await queryClient.cancelQueries({ queryKey: ["datasets"] });
      queryClient.setQueryData<Awaited<ReturnType<typeof client.datasets.list>>>(
        ["datasets"],
        (old) =>
          old?.map((r) => (r.datasetId === input.datasetId ? { ...r, name: input.name } : r)) ??
          old,
      );
      void queryClient.invalidateQueries({ queryKey: ["datasets"] });
    },
  });
}

export function RenameDatasetDialog({
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
        <DialogTitle>Rename dataset</DialogTitle>
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

function CreateDatasetDialog({
  open,
  onOpenChange,
  takenNames,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenNames: ReadonlyArray<string>;
  onCreated: (datasetId: string) => void;
}) {
  const [name, setName] = useState("");
  const [importer, setImporter] = useState<string>(AVAILABLE_IMPORTERS[0].name);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDuplicate, setShowDuplicate] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setImporter(AVAILABLE_IMPORTERS[0].name);
      setSource("");
      setError(null);
      setShowDuplicate(false);
    }
  }

  const create = useMutation({
    mutationFn: () =>
      client.datasets.create({ name: name.trim(), importer, sourceUri: source.trim() }),
    onSuccess: (res) => {
      onCreated(res.datasetId);
      onOpenChange(false);
    },
    onError: (e) => setError(e.message),
  });

  const pending = create.isPending;
  // Mirrors the server's org-scoped duplicate-name check from the already-
  // loaded list — the server stays authoritative. Only surfaced on submit:
  // typing toward "Voter File 2026" passes through "Voter File", and warning
  // on a name that was never going to be submitted is noise.
  const duplicate = takenNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());
  const valid = name.trim().length > 0 && source.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Import dataset</DialogTitle>
        <DialogDescription>
          Import a source file as a new dataset. Type is fixed after creation; use updates
          afterwards to get newer versions.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            if (duplicate) {
              setShowDuplicate(true);
              return;
            }
            create.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setError(null);
                setShowDuplicate(false);
                setName(e.target.value);
              }}
              placeholder="Name of dataset..."
              disabled={pending}
            />
            {showDuplicate ? (
              <Callout tone="pending">
                You already have a dataset with this name. You can “Update” the existing dataset to
                import a newer version.
              </Callout>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Type</label>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_IMPORTERS.map((imp) => {
                const sel = importer === imp.name;
                return (
                  <button
                    type="button"
                    key={imp.name}
                    onClick={() => setImporter(imp.name)}
                    disabled={pending}
                    className={cn(
                      "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
                      sel ? "bg-foreground/10" : "bg-background hover:bg-muted",
                    )}
                  >
                    {imp.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Source</label>
            <Input
              value={source}
              onChange={(e) => {
                setError(null);
                setSource(e.target.value);
              }}
              placeholder="e.g. https://example.com/voters.parquet"
              disabled={pending}
            />
            <span className="text-sm text-muted-foreground italic">URL of the raw file</span>
          </div>
          {error ? <DialogError error={error} /> : null}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Import
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
