import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";

// Shown in place of a data-dependent editor (segments/campaigns/zones) when the
// org has no active dataset version. Those pages can't function until one is
// imported and activated in Data. Dismissing returns to Overview so the user is
// never stranded on an empty page.
export function NoActiveDataset({
  entity,
  orgSlug,
  canManage,
}: {
  entity: string;
  orgSlug: string;
  canManage: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void navigate({ to: "/$orgSlug/overview", params: { orgSlug } });
      }}
    >
      <DialogContent>
        <DialogTitle>No dataset yet</DialogTitle>
        <DialogDescription>
          {canManage
            ? `Import a dataset to start building ${entity}`
            : "No dataset has been set up yet. Ask an admin to import one"}
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="outline" />}>Back to overview</DialogClose>
          {canManage ? (
            <Button
              render={<Link to="/$orgSlug/data" params={{ orgSlug }} search={{ status: null }} />}
            >
              Go to Data
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
