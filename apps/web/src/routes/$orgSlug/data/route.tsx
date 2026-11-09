import { Icon } from "~/components/icon";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Input } from "~/components/input";
import { Rail, useShowArchived } from "~/components/rail";
import { cleanSources, findImporter, sourcesComplete, type ImporterSpec } from "~/lib/importers";
import { datasetsListQuery } from "~/lib/queries/datasets";
import { importersQuery } from "~/lib/queries/importers";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

export const Route = createFileRoute("/$orgSlug/data")({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.fetchQuery(datasetsListQuery()),
      queryClient.fetchQuery(importersQuery()),
    ]),
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
  const { data: importers } = useSuspenseQuery(importersQuery());
  const [name, setName] = useState("");
  const [importerName, setImporterName] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  // Optional fixed slice, like type: a field of the selected importer plus the
  // values to keep, as the file's own codes in comma-separated text, parsed on
  // submit.
  const [filterColumn, setFilterColumn] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDuplicate, setShowDuplicate] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setImporterName(null);
      setSources({});
      setFilterColumn(null);
      setFilterText("");
      setError(null);
      setShowDuplicate(false);
    }
  }

  const importer = importerName ? findImporter(importers, importerName) : null;
  const typeDropdown = useDeferredRadioDropdown({
    onCommit: (next) => {
      if (next === importerName) return;
      setError(null);
      setImporterName(next);
      setSources({});
      setFilterColumn(null);
      setFilterText("");
    },
  });
  const filterField = importer?.filters.find((f) => f.column === filterColumn) ?? null;
  const parsedFilterValues = Array.from(
    new Set(
      filterText
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );
  const importFilter =
    filterField && parsedFilterValues.length > 0
      ? { column: filterField.column, values: parsedFilterValues }
      : null;

  const create = useMutation({
    mutationFn: () =>
      client.datasets.create({
        name: name.trim(),
        importer: importerName!,
        sources: cleanSources(sources),
        importFilter,
      }),
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
  const valid =
    name.trim().length > 0 &&
    importer != null &&
    sourcesComplete(importer, sources) &&
    (filterField == null || importFilter != null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Import dataset</DialogTitle>
        <DialogDescription>
          Import a source file as a new dataset. Dataset type is fixed after creation, as are any
          optional filters. Use updates afterwards to get newer versions.
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
            <DropdownMenu {...typeDropdown.menu}>
              <DropdownMenuTrigger
                disabled={pending}
                className={cn(
                  "flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm",
                  "enabled:hover:bg-muted disabled:cursor-not-allowed",
                )}
              >
                <span className="truncate">{importer?.label ?? "Choose a type..."}</span>
                <Icon name="chevron-down" className="size-3.5 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[var(--anchor-width)]">
                <DropdownMenuRadioGroup {...typeDropdown.radio} value={importerName ?? ""}>
                  {importers.map((imp) => (
                    <DropdownMenuRadioItem key={imp.name} value={imp.name}>
                      {imp.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {importer ? (
              <span className="text-sm text-muted-foreground italic">{importer.description}</span>
            ) : null}
          </div>
          {importer ? (
            <>
              <SourceInputs
                importer={importer}
                sources={sources}
                onChange={(next) => {
                  setError(null);
                  setSources(next);
                }}
                disabled={pending}
              />
              {importer.filters.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Filter</label>
                  <div className="flex flex-wrap gap-1.5">
                    {[{ column: null, label: "None" }, ...importer.filters].map((f) => {
                      const sel = filterColumn === f.column;
                      return (
                        <button
                          type="button"
                          key={f.column ?? "none"}
                          onClick={() => {
                            setError(null);
                            setFilterColumn(f.column);
                            setFilterText("");
                          }}
                          disabled={pending}
                          className={cn(
                            "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
                            sel ? "bg-foreground/10" : "bg-background hover:bg-muted",
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                  {filterField ? (
                    <Input
                      value={filterText}
                      onChange={(e) => {
                        setError(null);
                        setFilterText(e.target.value);
                      }}
                      placeholder="single or comma-separated"
                      disabled={pending}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
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

// One input per file the importer reads. Shared by create and the dataset
// page's update, where the importer is fixed.
export function SourceInputs({
  importer,
  sources,
  onChange,
  disabled,
  autoFocus,
}: {
  importer: ImporterSpec;
  sources: Record<string, string>;
  onChange: (sources: Record<string, string>) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return importer.sources.map((source, i) => (
    <div key={source.key} className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">
        {source.label}
        {source.required ? null : <span className="text-muted-foreground"> (optional)</span>}
      </label>
      <Input
        autoFocus={autoFocus && i === 0}
        value={sources[source.key] ?? ""}
        onChange={(e) => onChange({ ...sources, [source.key]: e.target.value })}
        placeholder="https://..."
        disabled={disabled}
      />
      <span className="text-sm text-muted-foreground italic">{source.description}</span>
    </div>
  ));
}
