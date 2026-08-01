import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useNavigate,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import {
  Activity,
  Archive,
  ArchiveRestore,
  Check,
  Columns2,
  FileText,
  MoreHorizontal,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/button";
import { Callout, DialogError } from "~/components/callout";
import {
  Dialog,
  DialogClose,
  DialogCloseX,
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
import { Filter } from "~/components/filter";
import { Input } from "~/components/input";
import { Pill } from "~/components/pill";
import { Switch } from "~/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { formatDateTime } from "~/lib/format";
import { importerLabel } from "~/lib/importers";
import { rememberSelection } from "~/lib/last-selected";
import { GRAY, GREEN, RED, YELLOW } from "~/lib/palette";
import type { CustomFieldType } from "@turf-tools/db/schema";
import {
  baseFieldsQuery,
  customFieldExamplesQuery,
  customFieldsQuery,
} from "~/lib/queries/custom-fields";
import { datasetsListQuery } from "~/lib/queries/datasets";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { cn } from "~/lib/utils";
import { client } from "~/rpc/client";

const STATUS_META: Record<string, { label: string; color: string }> = {
  importing: { label: "Importing", color: YELLOW },
  ready: { label: "Ready", color: GREEN },
  failed: { label: "Failed", color: RED },
};

// Display names for base (manifest) field kinds in the fields card.
const BASE_KIND_LABELS: Record<string, string> = {
  enum: "Category",
  text: "Text",
  "text-multi": "Code",
  "date-range": "Date",
  "age-range": "Age",
  "voting-history-count": "Voting history",
  "voting-history-detail": "Voting history",
  address: "Address",
};

const FIELD_TYPE_META: Record<CustomFieldType, string> = {
  enum: "Category",
  number: "Number",
  date: "Date",
  text: "Text",
  text_multi: "Code",
};

type DataSearch = {
  status: "current" | "archived" | "all";
};

const STATUS_OPTIONS = [
  { value: "archived", label: "Archived" },
  { value: "all", label: "All versions" },
];

export const Route = createFileRoute("/$orgSlug/data/$datasetId")({
  // SearchSchemaInput keeps ?status optional at link/redirect sites while the
  // validated shape stays required.
  validateSearch: (search: { status?: string } & SearchSchemaInput): DataSearch => ({
    status: search.status === "archived" || search.status === "all" ? search.status : "current",
  }),
  loader: async ({ context: { queryClient }, params: { orgSlug, datasetId }, preload }) => {
    const rows = await queryClient.fetchQuery(datasetsListQuery());
    const exists = rows.some((r) => r.datasetId === datasetId);
    if (!exists) {
      // Redirect only on real navigations — a redirect thrown during a
      // hover preload gets committed and auto-navigates. Loader at /data
      // picks the fallback.
      if (preload) return;
      throw redirect({ to: "/$orgSlug/data", params: { orgSlug } });
    }
    // Prefetch the fields queries so the cards render complete on first paint.
    const readyVersionId =
      rows.find((r) => r.datasetId === datasetId && r.status === "ready")?.versionId ?? null;
    await Promise.all([
      queryClient.fetchQuery(customFieldsQuery(datasetId)),
      queryClient.fetchQuery(baseFieldsQuery(readyVersionId)),
    ]);
  },
  component: DatasetPage,
});

type VersionRow = Awaited<ReturnType<typeof client.datasets.list>>[number];

function DatasetPage() {
  const { session } = Route.useRouteContext();
  const { orgSlug, datasetId } = Route.useParams();
  const timezone = session?.user?.displayTimezone ?? DEFAULT_DISPLAY_TIMEZONE;

  // The data index redirects back here next visit.
  useEffect(() => {
    rememberSelection(orgSlug, "data", datasetId);
  }, [orgSlug, datasetId]);

  // The layout's observer owns the importing poll; this one just reads.
  const { data: versionRows } = useSuspenseQuery(datasetsListQuery());
  const versions = versionRows.filter((r) => r.datasetId === datasetId);
  const first = versions[0];
  if (!first) return null;

  return (
    <DatasetEditor
      key={datasetId}
      dataset={{ datasetId, name: first.name, importer: first.importer, versions }}
      orgSlug={orgSlug}
      timezone={timezone}
    />
  );
}

function DatasetEditor({
  dataset,
  orgSlug,
  timezone,
}: {
  dataset: { datasetId: string; name: string; importer: string; versions: VersionRow[] };
  orgSlug: string;
  timezone: string;
}) {
  const queryClient = useQueryClient();
  // Loader-prefetched; suspense keeps the card from painting incomplete.
  const { data: fields } = useSuspenseQuery(customFieldsQuery(dataset.datasetId));
  // Versions arrive newest-first, so this is the latest ready version. The
  // key flips when an import lands — keep the old list up while the new
  // version's fields load instead of suspending the whole route.
  const readyVersionId = dataset.versions.find((v) => v.status === "ready")?.versionId ?? null;
  const { data: baseFields = [] } = useQuery({
    ...baseFieldsQuery(readyVersionId),
    placeholderData: keepPreviousData,
  });

  const importing = dataset.versions.some((v) => v.status === "importing");

  const [updateOpen, setUpdateOpen] = useState(false);
  const [appendOpen, setAppendOpen] = useState(false);

  // null in URL = "current" (the default). The Filter helper maps null →
  // its allLabel option; we translate between that and the search param.
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filterValue = status === "current" ? null : status;
  const onStatusChange = (next: string | null) =>
    void navigate({
      search: (prev) => ({ ...prev, status: (next ?? "current") as DataSearch["status"] }),
    });
  const statusLabel =
    filterValue === null
      ? "Current"
      : (STATUS_OPTIONS.find((o) => o.value === filterValue)?.label ?? "Current");

  const invalidateFields = () => {
    // Both keys: this dataset's list (the card) and the active-dataset list
    // (the segment editor's filter catalog).
    void queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
  };

  // Which field the edit dialog targets — held separately from the open flag
  // so the dialog body doesn't flash a fallback during the close animation.
  const [fieldTarget, setFieldTarget] = useState<FieldRow | null>(null);
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);

  return (
    <EditorPage>
      <EditorHeader title={dataset.name} subtitle={importerLabel(dataset.importer)}>
        <Filter
          icon={<Activity className="size-3.5" />}
          label={statusLabel}
          value={filterValue}
          options={STATUS_OPTIONS}
          allLabel="Current"
          onChange={onStatusChange}
        />
        <Button variant="outline" onClick={() => setAppendOpen(true)}>
          <Columns2 className="size-4" />
          Append
        </Button>
        <Button onClick={() => setUpdateOpen(true)} disabled={importing}>
          <Upload className="size-4" />
          Update
        </Button>
      </EditorHeader>

      <UpdateDialog
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        datasetId={dataset.datasetId}
        datasetName={dataset.name}
        onUpdated={() => void queryClient.invalidateQueries({ queryKey: ["datasets"] })}
      />
      <AppendDialog
        open={appendOpen}
        onOpenChange={setAppendOpen}
        orgSlug={orgSlug}
        datasetId={dataset.datasetId}
        onAppended={invalidateFields}
      />
      <FieldDialog
        open={fieldDialogOpen}
        onOpenChange={setFieldDialogOpen}
        field={fieldTarget}
        onDone={invalidateFields}
      />

      <div className="flex min-h-0 flex-1 gap-6">
        <VersionsCard versions={dataset.versions} timezone={timezone} status={status} />
        <FieldsCard
          fields={fields}
          baseFields={baseFields}
          hasImport={readyVersionId != null}
          onSelect={(f) => {
            setFieldTarget(f);
            setFieldDialogOpen(true);
          }}
        />
      </div>
    </EditorPage>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

function VersionsCard({
  versions,
  timezone,
  status,
}: {
  versions: VersionRow[];
  timezone: string;
  status: DataSearch["status"];
}) {
  const queryClient = useQueryClient();

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

  const visible = versions.filter((v) =>
    status === "all" ? true : status === "archived" ? v.isArchived : !v.isArchived,
  );

  // Which version the details dialog shows — held separately from the open
  // flag so the dialog body doesn't flash a fallback during the close
  // animation.
  const [detailsVersion, setDetailsVersion] = useState<VersionRow | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        version={detailsVersion}
        timezone={timezone}
      />
      <Table containerClassName="min-h-0 flex-1 overflow-y-auto" className="table-fixed">
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
          <TableRow>
            <TableHead className="w-15">Version</TableHead>
            <TableHead className="w-36">Status</TableHead>
            <TableHead>People</TableHead>
            <TableHead>Imported</TableHead>
            <TableHead className="w-15">Active</TableHead>
            <TableHead className="w-11" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow className="h-10">
              <TableCell colSpan={6}>
                <Pill>
                  <span>No results</span>
                </Pill>
              </TableCell>
            </TableRow>
          ) : null}
          {visible.map((v) => {
            const status = STATUS_META[v.status ?? ""] ?? {
              label: v.status ?? "—",
              color: GRAY,
            };
            // While importing, always show a percentage (0% before the job has
            // written any progress) so it never reads as a bare "Importing".
            const pct =
              v.status === "importing"
                ? v.importTotalSteps
                  ? Math.min(100, Math.round(((v.importStep ?? 0) / v.importTotalSteps) * 100))
                  : 0
                : null;
            return (
              <TableRow key={v.versionId} className={cn(v.isArchived && "text-muted-foreground")}>
                <TableCell>
                  <Pill className="tabular-nums">v{v.versionNumber}</Pill>
                </TableCell>
                <TableCell>
                  <Pill color={status.color} className="tabular-nums">
                    <span className="truncate">
                      {pct != null ? `Importing (${pct}%)` : status.label}
                    </span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="min-w-0">
                    <span className="truncate">
                      {v.rowCount != null ? v.rowCount.toLocaleString() : ""}
                    </span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill variant="number" className="min-w-0">
                    <span className="truncate">{formatDateTime(v.importedAt, timezone)}</span>
                  </Pill>
                </TableCell>
                <TableCell>
                  <Pill className="justify-center">
                    {v.isActive ? <Check className="size-4" /> : null}
                  </Pill>
                </TableCell>
                <TableCell>
                  <VersionRowMenu
                    canActivate={!v.isActive && v.status === "ready" && !v.isArchived}
                    isArchived={v.isArchived}
                    canArchive={
                      !v.isActive &&
                      !v.isArchived &&
                      (v.status === "ready" || v.status === "failed")
                    }
                    onMakeActive={() => makeActive.mutate(v.versionId)}
                    onArchive={() => archive.mutate(v.versionId)}
                    onUnarchive={() => unarchive.mutate(v.versionId)}
                    onDetails={() => {
                      setDetailsVersion(v);
                      setDetailsOpen(true);
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function VersionRowMenu({
  canActivate,
  isArchived,
  canArchive,
  onMakeActive,
  onArchive,
  onUnarchive,
  onDetails,
}: {
  canActivate: boolean;
  isArchived: boolean;
  canArchive: boolean;
  onMakeActive: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDetails: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="h-8 w-full" />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled={!canActivate} onClick={onMakeActive}>
          <Check />
          Make active
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDetails}>
          <FileText />
          Details
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

// One version's import at a glance: what ran and how it ended. The error
// comes from `dataset_versions.error` (null unless the import failed).
function DetailsDialog({
  open,
  onOpenChange,
  version,
  timezone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: VersionRow | null;
  timezone: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Details</DialogTitle>
        <DialogCloseX />
        <DialogDescription>
          Imported v{version?.versionNumber} of {version?.name} with type{" "}
          {importerLabel(version?.importer ?? "")}, started{" "}
          {formatDateTime(version?.importedAt, timezone)}.
        </DialogDescription>
        {version?.status === "failed" ? (
          <Callout tone="error">
            {version.error ?? "Failed, but no error message was recorded."}
          </Callout>
        ) : version?.status === "importing" ? (
          <Callout tone="pending">Import in progress — no errors so far.</Callout>
        ) : (
          <Callout tone="success">Completed with no errors.</Callout>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

type FieldRow = {
  customFieldId: string;
  label: string;
  fieldType: CustomFieldType;
  values: string[] | null;
  personCount: number;
  isArchived: boolean;
};

// Every custom field with its coverage, bars scaled to the largest. Click a
// row to rename/archive/clear; archived fields hide behind the footer toggle.
function FieldsCard({
  fields,
  baseFields,
  hasImport,
  onSelect,
}: {
  fields: FieldRow[];
  baseFields: Array<{ label: string; kind: string }>;
  // False until a version finishes importing — fields don't exist yet.
  hasImport: boolean;
  onSelect: (f: FieldRow) => void;
}) {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const visible = fields.filter((f) => showArchived || !f.isArchived);
  const sorted = [...visible].sort(
    (a, b) =>
      Number(a.isArchived) - Number(b.isArchived) ||
      b.personCount - a.personCount ||
      a.label.localeCompare(b.label),
  );
  const max = visible.reduce((m, f) => Math.max(m, f.personCount), 0);
  const hasArchived = fields.some((f) => f.isArchived);

  return (
    // -mt aligns the "Custom fields" heading with the versions table's
    // header text (border + pt-3 lands 3px below the th's centered text).
    <div className="-mt-[3px] flex min-h-0 w-80 shrink-0 flex-col rounded-md border border-border bg-card">
      <div className="flex flex-1 flex-col overflow-y-auto">
        {sorted.length > 0 ? (
          <div className="px-3.5 pt-3 pb-1 text-sm text-muted-foreground">Custom fields</div>
        ) : null}
        <div className={cn("flex flex-col gap-0 p-2 pt-1", sorted.length === 0 && "hidden")}>
          {sorted.map((f) => (
            <button
              type="button"
              key={f.customFieldId}
              onClick={() => onSelect(f)}
              // Warm the dialog's examples during hover→click latency so it
              // opens complete instead of popping the section in.
              onMouseEnter={() => {
                if (f.fieldType !== "enum")
                  void queryClient.prefetchQuery(customFieldExamplesQuery(f.customFieldId));
              }}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                // min-h keeps rows a consistent height whether or not the
                // coverage bar wraps below a long label.
                "flex min-h-10 flex-col justify-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-muted",
                f.isArchived && "text-muted-foreground",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm">{f.label}</span>
                <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                  {FIELD_TYPE_META[f.fieldType]} ·{" "}
                  {f.isArchived
                    ? `${f.personCount.toLocaleString()} (Archived)`
                    : f.personCount.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-foreground/40"
                  // Zero coverage → truly empty track; the 2% floor only applies
                  // to nonzero counts so small fields stay visible.
                  style={{
                    width: `${
                      !f.isArchived && f.personCount > 0 && max > 0
                        ? Math.max(2, (f.personCount / max) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </button>
          ))}
        </div>
        {hasImport ? (
          <>
            <div className="px-3.5 pt-3 pb-2 text-sm text-muted-foreground">Base fields</div>
            <div className="flex flex-col gap-1 p-2 pt-1 pb-3">
              {baseFields.map((f) => (
                <div
                  key={f.label}
                  className="flex items-center justify-between gap-2 rounded-md px-1.5"
                >
                  <span className="min-w-0 truncate text-sm">{f.label}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {BASE_KIND_LABELS[f.kind] ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="px-3.5 pt-3 pb-2 text-sm text-muted-foreground">No imported dataset</div>
        )}
      </div>
      {hasArchived ? (
        <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
          <span className="text-sm text-muted-foreground">Show archived custom fields</span>
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
        </div>
      ) : null}
    </div>
  );
}

// Keep in sync with the sampling LIMIT in the data server's
// /custom-fields/examples, which caps the scalar-field sample.
const EXAMPLE_LIMIT = 10;

// Rename / archive / clear a custom field. Rename is
// safe by construction (criteria and lake values are id-keyed); archive is
// display-only and re-appending the label revives it; clear deletes values
// for everyone (the field stays, at zero coverage).
function FieldDialog({
  open,
  onOpenChange,
  field,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  field: FieldRow | null;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLabel(field?.label ?? "");
      setError(null);
    }
  }

  // Category fields carry their full option set on the registry row — no
  // fetch; scalar fields sample the lake. null = still loading (the section
  // shell reserves its space and the chips fade in).
  const isEnum = field?.fieldType === "enum";
  const { data: sampled } = useQuery({
    ...customFieldExamplesQuery(field?.customFieldId ?? ""),
    enabled: open && field != null && !isEnum,
  });
  const examples = isEnum ? (field?.values ?? []).slice(0, EXAMPLE_LIMIT) : (sampled ?? null);
  const moreCount = isEnum ? Math.max(0, (field?.values?.length ?? 0) - EXAMPLE_LIMIT) : 0;

  const done = () => {
    onDone();
    onOpenChange(false);
  };
  const rename = useMutation({
    mutationFn: (next: string) =>
      client.customFields.rename({ customFieldId: field!.customFieldId, label: next }),
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const setArchived = useMutation({
    mutationFn: (archived: boolean) =>
      archived
        ? client.customFields.archive({ customFieldId: field!.customFieldId })
        : client.customFields.unarchive({ customFieldId: field!.customFieldId }),
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const clear = useMutation({
    mutationFn: () => client.customFields.clear({ customFieldId: field!.customFieldId }),
    onSuccess: done,
    onError: (e) => setError(e.message),
  });

  const pending = rename.isPending || setArchived.isPending || clear.isPending;
  const changed = field != null && label.trim() !== field.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Edit field</DialogTitle>
        <DialogDescription>
          Rename the field, clear its values from everyone, or archive to hide it until you need it
          again.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!changed || pending || !label.trim()) return;
            rename.mutate(label.trim());
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={label}
              onChange={(e) => {
                setError(null);
                setLabel(e.target.value);
              }}
              disabled={pending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Type</label>
            {/* Static — retyping a field would invalidate already-typed
                values; the honest path is clear + re-append. */}
            <span className="w-fit rounded-md bg-muted px-2.5 py-1 text-sm">
              {field ? FIELD_TYPE_META[field.fieldType] : ""}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Examples</label>
            {/* min-h reserves one chip row so late-arriving samples fade in
                without shifting the layout below. */}
            <div className="flex min-h-7 flex-wrap items-center gap-1.5">
              {examples == null ? null : examples.length === 0 ? (
                <span className="text-sm text-muted-foreground italic">No values yet</span>
              ) : (
                <>
                  {examples.map((v) => (
                    <span
                      key={v}
                      className={cn(
                        "max-w-40 truncate rounded-md bg-muted px-2.5 py-1 text-sm",
                        "animate-in fade-in duration-200",
                      )}
                    >
                      {v}
                    </span>
                  ))}
                  {moreCount > 0 ? (
                    <span className="text-sm text-muted-foreground">+{moreCount} more</span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {error ? <DialogError error={error} /> : null}
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex gap-2">
              {field?.isArchived ? (
                <Button
                  type="button"
                  variant="outline"
                  className="disabled:opacity-100"
                  disabled={pending}
                  onClick={() => setArchived.mutate(false)}
                >
                  <ArchiveRestore className="size-4" />
                  Unarchive
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  className="disabled:opacity-100"
                  disabled={pending}
                  onClick={() => setArchived.mutate(true)}
                >
                  <Archive className="size-4" />
                  Archive
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                className="disabled:opacity-100"
                disabled={pending || field == null || field.personCount === 0}
                onClick={() => clear.mutate()}
              >
                Clear
              </Button>
            </div>
            <div className="flex gap-2">
              <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!changed || !label.trim()} loading={pending}>
                Save
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dialogs: update / append
// ---------------------------------------------------------------------------

function UpdateDialog({
  open,
  onOpenChange,
  datasetId,
  datasetName,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: string;
  datasetName: string;
  onUpdated: () => void;
}) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSource("");
      setError(null);
    }
  }

  const update = useMutation({
    mutationFn: () => client.datasets.update({ datasetId, sourceUri: source.trim() }),
    onSuccess: () => {
      onUpdated();
      onOpenChange(false);
    },
    onError: (e) => setError(e.message),
  });

  const pending = update.isPending;
  const valid = source.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Update dataset</DialogTitle>
        <DialogDescription>
          Imports a new version of{" "}
          <span className="font-medium text-foreground">{datasetName}</span>. Segments and campaigns
          carry over; the new version stays inactive until you make it active.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || pending) return;
            update.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Source</label>
            <Input
              autoFocus
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
              Import version
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Pick-time inspection reads only what it must: parquet schemas come from the
// file's footer, parsed client-side (exact — no sniffing); CSVs send a head
// slice to the server so DuckDB stays the one dialect sniffer and the form
// shape can never diverge from what append will see. The full file crosses
// the wire once, on append.
const CSV_INSPECT_BYTES = 64 * 1024;

async function inspectFile(orgSlug: string, file: File): Promise<string[]> {
  const magic = await file.slice(0, 4).arrayBuffer();
  if (new TextDecoder().decode(magic) === "PAR1") {
    const { parquetMetadataAsync, parquetSchema } = await import("hyparquet");
    const metadata = await parquetMetadataAsync({
      byteLength: file.size,
      slice: (start: number, end?: number) => file.slice(start, end).arrayBuffer(),
    });
    const columns = parquetSchema(metadata).children.map((c) => c.element.name);
    if (columns.length === 0) throw new Error("Uploaded file has no columns.");
    if (columns.length > 2)
      throw new Error(
        `File has ${columns.length} columns, must have one (IDs only) or two (IDs and values).`,
      );
    return columns;
  }
  let body: Blob = file;
  if (file.size > CSV_INSPECT_BYTES) {
    // Trim the slice to the last complete line so DuckDB never sees a
    // mid-row truncation.
    const head = await file.slice(0, CSV_INSPECT_BYTES).text();
    const cut = head.lastIndexOf("\n");
    body = new Blob([cut > 0 ? head.slice(0, cut) : head]);
  }
  const res = await fetch(`/api/web/${orgSlug}/custom-field-inspect`, { method: "POST", body });
  if (!res.ok) throw new Error(await res.text());
  const { columns } = (await res.json()) as { columns: string[] };
  return columns;
}

type AppendStats = {
  fields: string[];
  rowCount: number;
  skippedCount: number;
  matchedCount: number | null;
};

// Append a file of (id, value) rows as a custom field. Ingest is synchronous —
// the submit request parses, writes, and returns match stats (or the parse
// error) directly; there is no job or polling.
function AppendDialog({
  open,
  onOpenChange,
  orgSlug,
  datasetId,
  onAppended,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  datasetId: string;
  onAppended: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // From pick-time inspection (parquet footer client-side, CSV head via the
  // server) — the file drives which inputs render.
  const [fileInfo, setFileInfo] = useState<{
    columns: number;
    valueHeader: string | null;
  } | null>(null);
  // Gates submit while pick-time inspection is in flight; deliberately no
  // loading UI — inspection is near-instant (parquet footer / 64KB CSV
  // head), and every indicator tried here (label swap, button spinner)
  // read as flicker in the common fast case.
  const [inspecting, setInspecting] = useState(false);
  const [fieldType, setFieldType] = useState<CustomFieldType>("enum");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AppendStats | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFile(null);
      setFileInfo(null);
      setFieldType("enum");
      setLabel("");
      setValue("");
      setError(null);
      setStats(null);
    }
  }

  const resetFeedback = () => setError(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (!file || !fileInfo) return;
      const params = new URLSearchParams({ datasetId, fieldType, filename: file.name });
      if (fileInfo.columns === 1) {
        params.set("label", label.trim());
        params.set("value", value.trim());
      }
      const res = await fetch(`/api/web/${orgSlug}/custom-field-append?${params.toString()}`, {
        method: "POST",
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as AppendStats;
    },
    onSuccess: (res) => {
      if (!res) return;
      setStats(res);
      onAppended();
    },
    onError: (e) => setError(e.message),
  });

  const pending = submit.isPending;
  const valid =
    !inspecting &&
    file != null &&
    fileInfo != null &&
    (fileInfo.columns === 2 || (label.trim().length > 0 && value.trim().length > 0));

  return (
    <Dialog open={open} onOpenChange={(next) => (pending && !next ? null : onOpenChange(next))}>
      <DialogContent>
        <DialogTitle>Append</DialogTitle>
        <DialogDescription>
          Add a column to this dataset from a file. Format should be one column (IDs) or two columns
          (IDs and values) and a header is required. Appended columns will apply to all dataset
          versions with matching IDs.
        </DialogDescription>
        {stats ? (
          <div className="flex flex-col gap-4">
            <Callout tone="success">
              Appended column "<span className="font-medium">{stats.fields.join(", ")}</span>" with{" "}
              <span className="font-medium">{stats.rowCount.toLocaleString()}</span> rows
              {stats.matchedCount != null ? (
                <>
                  {" "}
                  and <span className="font-medium">
                    {stats.matchedCount.toLocaleString()}
                  </span>{" "}
                  matched people
                </>
              ) : null}
              .
              {stats.skippedCount ? (
                <>
                  {" "}
                  <span className="font-medium">{stats.skippedCount.toLocaleString()}</span> rows
                  without values were ignored.
                </>
              ) : null}
            </Callout>
            <div className="flex justify-end">
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || pending) return;
              setError(null);
              submit.mutate();
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">File</label>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,.parquet"
                className="hidden"
                onChange={(e) => {
                  resetFeedback();
                  const next = e.target.files?.[0] ?? null;
                  setFile(next);
                  setFileInfo(null);
                  if (!next) return;
                  setInspecting(true);
                  inspectFile(orgSlug, next)
                    .then((columns) =>
                      setFileInfo({
                        columns: columns.length,
                        valueHeader: columns[1]?.trim() ?? null,
                      }),
                    )
                    .catch((err: Error) => {
                      setError(err.message);
                      setFile(null);
                    })
                    .finally(() => setInspecting(false));
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="justify-start disabled:opacity-100"
                disabled={pending}
                onClick={() => fileRef.current?.click()}
              >
                <span className="truncate">
                  {file ? file.name : "Choose a file (CSV or Parquet)..."}
                </span>
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Type</label>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(FIELD_TYPE_META) as CustomFieldType[]).map((t) => {
                  const sel = fieldType === t;
                  return (
                    <button
                      type="button"
                      key={t}
                      onClick={() => {
                        resetFeedback();
                        setFieldType(t);
                      }}
                      disabled={pending}
                      className={cn(
                        "rounded-md border border-border px-2.5 py-1 text-sm disabled:cursor-not-allowed active:translate-y-px",
                        sel ? "bg-foreground/10" : "bg-background hover:bg-muted",
                      )}
                    >
                      {FIELD_TYPE_META[t]}
                    </button>
                  );
                })}
              </div>
            </div>

            {fileInfo?.columns === 2 ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Field name</label>
                <Input value={fileInfo.valueHeader ?? ""} disabled readOnly />
                <span className="text-sm text-muted-foreground italic">
                  Fixed from the file's value column, you can rename later
                </span>
              </div>
            ) : null}
            {fileInfo?.columns === 1 ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Field name</label>
                  <Input
                    value={label}
                    onChange={(e) => {
                      resetFeedback();
                      setLabel(e.target.value);
                    }}
                    placeholder="Required"
                    disabled={pending}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Value</label>
                  <Input
                    value={value}
                    onChange={(e) => {
                      resetFeedback();
                      setValue(e.target.value);
                    }}
                    placeholder="Required"
                    disabled={pending}
                  />
                  <span className="text-sm text-muted-foreground italic">
                    Everyone in the list gets this value
                  </span>
                </div>
              </>
            ) : null}
            {error ? <DialogError error={error} /> : null}
            <div className="mt-2 flex justify-end gap-2">
              <DialogClose render={<Button variant="outline" type="button" disabled={pending} />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={!valid} loading={pending}>
                Append
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
