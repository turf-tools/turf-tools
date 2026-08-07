import { Trash2 } from "lucide-react";
import { Button } from "~/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/dialog";
import { useConfirmHotkey } from "~/lib/use-confirm-hotkey";

export type DeleteBlocker = { label: string; count: number };

// "2 campaigns and 5 turfs" — for the blocked explanation.
function blockerText(blockers: DeleteBlocker[]): string {
  const parts = blockers.map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Permanent-delete confirm for archived entities. Two modes from one
// snapshot: referenced → explanation with no destructive action;
// unreferenced → the one confirm in the app that really means forever.
export function DeleteDialog({
  open,
  onOpenChange,
  entity,
  name,
  blockers,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: string;
  name: string;
  blockers: DeleteBlocker[];
  pending: boolean;
  onConfirm: () => void;
}) {
  const blocked = blockers.length > 0;
  useConfirmHotkey({ open, disabled: pending || blocked, onConfirm });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{blocked ? `Can't delete ${entity}` : `Delete ${entity}?`}</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{name}</span>{" "}
          {blocked ? (
            <>is referenced by {blockerText(blockers)}, so it can be archived but not deleted.</>
          ) : (
            <>will be deleted permanently. This can't be undone.</>
          )}
        </DialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          {blocked ? (
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onConfirm} loading={pending}>
                <Trash2 />
                Delete {entity}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
