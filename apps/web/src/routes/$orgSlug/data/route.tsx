import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate, useParams } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/button";
import { DialogError } from "~/components/callout";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { Input } from "~/components/input";
import { Rail } from "~/components/rail";
import { AVAILABLE_IMPORTERS } from "~/lib/importers";
import { hasPermission } from "~/lib/permissions";
import { datasetsListQuery } from "~/lib/queries/datasets";
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
  // (already name-sorted).
  const datasets = useMemo(() => {
    const byId = new Map<string, { datasetId: string; name: string; isActive: boolean }>();
    for (const r of versionRows) {
      const g = byId.get(r.datasetId) ?? { datasetId: r.datasetId, name: r.name, isActive: false };
      g.isActive ||= r.isActive;
      byId.set(r.datasetId, g);
    }
    return [...byId.values()];
  }, [versionRows]);

  const goToDataset = (datasetId: string) =>
    navigate({ to: "/$orgSlug/data/$datasetId", params: { orgSlug, datasetId } });

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className={cn("flex h-[calc(100vh-3.5rem)]", shouldFade)}>
      <Rail>
        {datasets.map((d) => (
          <Rail.Item
            key={d.datasetId}
            label={d.name}
            active={d.datasetId === activeDatasetId}
            trailing={
              d.isActive ? (
                <Check className="ml-2 size-4 shrink-0 [stroke-width:2.25]" />
              ) : undefined
            }
            onSelect={() => void goToDataset(d.datasetId)}
          />
        ))}
        <Rail.New label="Import dataset" onClick={() => setCreateOpen(true)} />
      </Rail>

      <CreateDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(datasetId) => {
          void queryClient.invalidateQueries({ queryKey: ["datasets"] });
          void goToDataset(datasetId);
        }}
      />

      <Outlet />
    </div>
  );
}

function CreateDatasetDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (datasetId: string) => void;
}) {
  const [name, setName] = useState("");
  const [importer, setImporter] = useState<string>(AVAILABLE_IMPORTERS[0].name);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setImporter(AVAILABLE_IMPORTERS[0].name);
      setSource("");
      setError(null);
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
                setName(e.target.value);
              }}
              placeholder="Name of dataset..."
              disabled={pending}
            />
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
