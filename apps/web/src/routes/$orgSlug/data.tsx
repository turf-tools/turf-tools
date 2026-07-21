import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/button";
import { Filter } from "~/components/filter";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { EditorHeader } from "~/components/editor-header";
import { Input } from "~/components/input";
import { Page } from "~/components/page";
import { Pill } from "~/components/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDate } from "~/lib/format";
import { AVAILABLE_IMPORTERS, importerLabel } from "~/lib/importers";
import { hasPermission } from "~/lib/permissions";
import { datasetsListQuery } from "~/lib/queries/datasets";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { useDialogMutation } from "~/lib/use-dialog-mutation";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

const STATUS_META: Record<string, { label: string; color: string }> = {
  importing: { label: "Importing", color: "#d97706" },
  ready: { label: "Ready", color: "#3ca951" },
  failed: { label: "Failed", color: "#ff725c" },
};

// Default (null) hides archived versions.
const STATUS_OPTIONS = [
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

export const Route = createFileRoute("/$orgSlug/data")({
  validateSearch: (search): { status: string | null } => ({
    status: typeof search.status === "string" ? search.status : null,
  }),
  beforeLoad: ({ context, params }) => {
    if (!hasPermission(context.role, "datasets.manage")) {
      throw redirect({ to: "/$orgSlug/overview", params: { orgSlug: params.orgSlug } });
    }
  },
  loader: ({ context: { queryClient } }) => queryClient.fetchQuery(datasetsListQuery()),
  component: DataPage,
});

function DataPage() {
  const { session } = Route.useRouteContext();
  const timezone = session?.user?.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const queryClient = useQueryClient();
  const { status: statusFilter } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: datasets = [] } = useQuery({
    ...datasetsListQuery(),
    // Poll while any version is importing so the row advances to Ready on its own.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "importing") ? 3000 : false),
  });

  const importDialog = useDialogMutation({
    mutationFn: async (
      input:
        | { mode: "new"; name: string; importer: string; sourceUri: string }
        | { mode: "update"; datasetId: string; sourceUri: string },
    ): Promise<void> => {
      if (input.mode === "new") {
        await client.datasets.create({
          name: input.name,
          importer: input.importer,
          sourceUri: input.sourceUri,
        });
      } else {
        await client.datasets.update({ datasetId: input.datasetId, sourceUri: input.sourceUri });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });

  const makeActive = useMutation({
    mutationFn: (versionId: string) => client.datasets.makeActive({ versionId }),
    // A new active version replaces the manifest that gates the editors, and the
    // election list the voting-history-detail filter picks from. Remove both (not
    // just invalidate) so those editors re-fetch clean — a hard-cached query
    // would otherwise render stale for a frame. Invalidate the rest — counts,
    // dataset-scoped lists — so they re-resolve on next read.
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["manifest"] });
      queryClient.removeQueries({ queryKey: ["elections"] });
      void queryClient.invalidateQueries();
    },
    onError: (e) => toast.error(e.message),
  });

  // Which dataset the Update dialog targets (its name is fixed; only the source
  // is entered). Held separately from the dialog's open flag so the name stays
  // put through the close animation.
  const [updateTarget, setUpdateTarget] = useState<{ datasetId: string; name: string } | null>(
    null,
  );
  const updateDialog = useDialogMutation({
    mutationFn: (input: { datasetId: string; sourceUri: string }) => client.datasets.update(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });

  const archive = useMutation({
    mutationFn: (versionId: string) => client.datasets.archive({ versionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
    onError: (e) => toast.error(e.message),
  });
  const unarchive = useMutation({
    mutationFn: (versionId: string) => client.datasets.unarchive({ versionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
    onError: (e) => toast.error(e.message),
  });

  // A dataset with an in-flight import can't take another until it finishes.
  // Computed over all datasets (not the filtered view) so the guard is correct.
  const importingDatasetIds = new Set(
    datasets.filter((r) => r.status === "importing").map((r) => r.datasetId),
  );

  // Distinct datasets with a ready, non-archived version and no import in flight
  // — what the import dialog's "Update existing" mode can target.
  const updatableById = new Map<string, { datasetId: string; name: string }>();
  for (const r of datasets) {
    if (r.status === "ready" && !r.isArchived && !importingDatasetIds.has(r.datasetId)) {
      updatableById.set(r.datasetId, { datasetId: r.datasetId, name: r.name });
    }
  }
  const updatableDatasets = [...updatableById.values()];

  const rows = datasets.filter((r) => {
    if (statusFilter === null && r.isArchived) return false;
    if (statusFilter === "archived" && !r.isArchived) return false;
    return true;
  });
  const statusLabel =
    statusFilter === null
      ? "All current"
      : (STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? null);

  return (
    <Page>
      <EditorHeader title="Data" subtitle="Voter files and other imported datasets">
        <Filter
          icon={<Activity className="size-3.5" />}
          label={statusLabel}
          value={statusFilter}
          options={STATUS_OPTIONS}
          allLabel="All current"
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, status: next }) })}
        />
        <Button onClick={importDialog.open}>
          <Plus className="size-4" />
          Import
        </Button>
      </EditorHeader>

      <ImportDialog
        open={importDialog.isOpen}
        onOpenChange={importDialog.onOpenChange}
        pending={importDialog.isPending}
        error={importDialog.error}
        clearError={importDialog.reset}
        datasets={updatableDatasets}
        onSubmit={(input) => importDialog.mutate(input)}
      />

      <UpdateDialog
        open={updateDialog.isOpen}
        onOpenChange={updateDialog.onOpenChange}
        datasetName={updateTarget?.name ?? null}
        pending={updateDialog.isPending}
        error={updateDialog.error}
        clearError={updateDialog.reset}
        onSubmit={(sourceUri) =>
          updateTarget && updateDialog.mutate({ datasetId: updateTarget.datasetId, sourceUri })
        }
      />

      <Table containerClassName="h-[calc(100vh-9rem)] overflow-y-auto" className="table-fixed">
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-56">Type</TableHead>
            <TableHead className="w-20">Version</TableHead>
            <TableHead className="w-36">Status</TableHead>
            <TableHead className="w-32">People</TableHead>
            <TableHead className="w-28">Imported</TableHead>
            <TableHead className="w-16">Active</TableHead>
            <TableHead className="w-11" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="h-10">
              <TableCell colSpan={8}>
                <Pill>
                  <span>
                    {datasets.length === 0
                      ? "No datasets — import a voter file to start building segments."
                      : "No results"}
                  </span>
                </Pill>
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((r) => {
            const status = STATUS_META[r.status ?? ""] ?? {
              label: r.status ?? "—",
              color: "#9ca3af",
            };
            // While importing, always show a percentage (0% before the job has
            // written any progress) so it never reads as a bare "Importing".
            const pct =
              r.status === "importing"
                ? r.importTotalSteps
                  ? Math.min(100, Math.round(((r.importStep ?? 0) / r.importTotalSteps) * 100))
                  : 0
                : null;
            const pillLabel = pct != null ? `Importing (${pct}%)` : status.label;
            return (
              <TableRow key={r.versionId} className={cn(r.isArchived && "text-muted-foreground")}>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{r.name}</span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="min-w-0">
                    <span className="truncate">{importerLabel(r.importer)}</span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="tabular-nums">v{r.versionNumber}</Pill>
                </TableCell>
                <TableCell>
                  <span
                    className="flex h-8 w-full items-center rounded-md border border-transparent bg-clip-padding px-2 text-sm tabular-nums"
                    style={{ backgroundColor: `${status.color}22`, color: status.color }}
                  >
                    <span className="truncate">{pillLabel}</span>
                  </span>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {r.rowCount != null ? r.rowCount.toLocaleString() : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number">
                    {r.importedAt ? formatDate(r.importedAt, timezone) : "—"}
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="justify-center">
                    {r.isActive ? <Check className="size-4" /> : null}
                  </Pill>
                </TableCell>
                <TableCell>
                  <DatasetRowMenu
                    canActivate={!r.isActive && r.status === "ready" && !r.isArchived}
                    canUpdate={!importingDatasetIds.has(r.datasetId)}
                    isArchived={r.isArchived}
                    canArchive={
                      !r.isActive &&
                      !r.isArchived &&
                      (r.status === "ready" || r.status === "failed")
                    }
                    onMakeActive={() => makeActive.mutate(r.versionId)}
                    onUpdate={() => {
                      setUpdateTarget({ datasetId: r.datasetId, name: r.name });
                      updateDialog.open();
                    }}
                    onArchive={() => archive.mutate(r.versionId)}
                    onUnarchive={() => unarchive.mutate(r.versionId)}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Page>
  );
}

type ImportSubmit =
  | { mode: "new"; name: string; importer: string; sourceUri: string }
  | { mode: "update"; datasetId: string; sourceUri: string };

function ImportDialog({
  open,
  onOpenChange,
  pending,
  error,
  clearError,
  datasets,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string | null;
  clearError: () => void;
  datasets: Array<{ datasetId: string; name: string }>;
  onSubmit: (input: ImportSubmit) => void;
}) {
  const [mode, setMode] = useState<"new" | "update">("new");
  const [name, setName] = useState("");
  const [importer, setImporter] = useState<string>(AVAILABLE_IMPORTERS[0].name);
  const [datasetId, setDatasetId] = useState<string>("");
  const [source, setSource] = useState("");

  // Editing after a failed submit clears the stale error.
  const edit = (set: (v: string) => void) => (v: string) => {
    if (error) clearError();
    set(v);
  };

  // Reset synchronously on open (not in a post-paint effect) so reopening never
  // flashes the previous submission's values.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode("new");
      setName("");
      setImporter(AVAILABLE_IMPORTERS[0].name);
      setDatasetId(datasets[0]?.datasetId ?? "");
      setSource("");
    }
  }

  // "Update existing" is only offered when there's a ready dataset to target.
  const canUpdate = datasets.length > 0;
  const valid =
    source.trim().length > 0 && (mode === "new" ? name.trim().length > 0 : datasetId.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Import</DialogTitle>
        <DialogDescription>
          Create a new dataset or update an existing one. Type will be fixed after creating a new
          dataset. Segments and campaigns will carry over on updates.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(
              mode === "new"
                ? { mode: "new", name: name.trim(), importer, sourceUri: source.trim() }
                : { mode: "update", datasetId, sourceUri: source.trim() },
            );
          }}
          className="flex flex-col gap-4"
        >
          {canUpdate ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Create or update</label>
              <div className="flex flex-wrap gap-1.5">
                {(["new", "update"] as const).map((m) => {
                  const selected = mode === m;
                  return (
                    <button
                      type="button"
                      key={m}
                      onClick={() => {
                        if (error) clearError();
                        setMode(m);
                      }}
                      disabled={pending}
                      className={cn(
                        "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
                        selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
                      )}
                    >
                      {m === "new" ? "New dataset" : "Update existing"}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {mode === "new" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Name</label>
                <Input
                  value={name}
                  onChange={(e) => edit(setName)(e.target.value)}
                  placeholder="Name of dataset..."
                  disabled={pending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Type</label>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_IMPORTERS.map((imp) => {
                    const selected = importer === imp.name;
                    return (
                      <button
                        type="button"
                        key={imp.name}
                        onClick={() => setImporter(imp.name)}
                        disabled={pending}
                        className={cn(
                          "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
                          selected ? "bg-foreground/10" : "bg-background hover:bg-muted",
                        )}
                      >
                        {imp.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Dataset</label>
              <DatasetSelect
                value={datasetId}
                datasets={datasets}
                onChange={(id) => {
                  if (error) clearError();
                  setDatasetId(id);
                }}
                disabled={pending}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Source</label>
            <Input
              value={source}
              onChange={(e) => edit(setSource)(e.target.value)}
              placeholder="e.g. https://example.com/voters.parquet"
              disabled={pending}
            />
            <span className="text-sm text-muted-foreground italic">URL of the raw file</span>
          </div>
          {error ? (
            <p
              className={cn(
                "rounded-md border border-destructive/40 bg-destructive/10",
                "px-3 py-2 text-sm text-destructive",
              )}
            >
              {error}
            </p>
          ) : null}
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

function DatasetSelect({
  value,
  datasets,
  onChange,
  disabled,
}: {
  value: string;
  datasets: Array<{ datasetId: string; name: string }>;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const dd = useDeferredRadioDropdown({ onCommit: (v) => onChange(v) });
  const selected = datasets.find((d) => d.datasetId === value);
  return (
    <DropdownMenu {...dd.menu}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="outline" type="button" className="w-full justify-between" />}
      >
        <span className="truncate">{selected?.name ?? "Select a dataset"}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup {...dd.radio} value={value}>
          {datasets.map((d) => (
            <DropdownMenuRadioItem key={d.datasetId} value={d.datasetId}>
              <span className="truncate">{d.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UpdateDialog({
  open,
  onOpenChange,
  datasetName,
  pending,
  error,
  clearError,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetName: string | null;
  pending: boolean;
  error: string | null;
  clearError: () => void;
  onSubmit: (sourceUri: string) => void;
}) {
  const [source, setSource] = useState("");

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSource("");
  }

  const valid = source.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Update dataset</DialogTitle>
        <DialogDescription>
          Imports a new version of{" "}
          <span className="font-medium text-foreground">{datasetName ?? "this dataset"}</span>. Your
          segments and campaigns carry over; the new version stays inactive until you make it
          active.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            onSubmit(source.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Source</label>
            <Input
              value={source}
              onChange={(e) => {
                if (error) clearError();
                setSource(e.target.value);
              }}
              placeholder="e.g. https://example.com/voters.parquet"
              disabled={pending}
            />
            <span className="text-sm text-muted-foreground italic">URL of the raw file</span>
          </div>
          {error ? (
            <p
              className={cn(
                "rounded-md border border-destructive/40 bg-destructive/10",
                "px-3 py-2 text-sm text-destructive",
              )}
            >
              {error}
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid} loading={pending}>
              Import version
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DatasetRowMenu({
  canActivate,
  canUpdate,
  isArchived,
  canArchive,
  onMakeActive,
  onUpdate,
  onArchive,
  onUnarchive,
}: {
  canActivate: boolean;
  canUpdate: boolean;
  isArchived: boolean;
  canArchive: boolean;
  onMakeActive: () => void;
  onUpdate: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("w-full bg-muted hover:bg-foreground/8", "aria-expanded:bg-foreground/8")}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled={!canActivate} onClick={onMakeActive}>
          <Check />
          Make active
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canUpdate} onClick={onUpdate}>
          <Upload />
          Update
        </DropdownMenuItem>
        {isArchived ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <ArchiveRestore />
            Unarchive
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" disabled={!canArchive} onClick={onArchive}>
            <Archive />
            Archive
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
