import { useHotkey } from "./use-hotkey";

// Mod-Enter (⌘ on macOS, Ctrl elsewhere) fires the dialog's destructive
// confirm. The dialog itself is the open `[role="dialog"]`, so dialog
// gating is off.
export function useConfirmHotkey({
  open,
  disabled,
  onConfirm,
}: {
  open: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  useHotkey({
    key: "Enter",
    mod: true,
    enabled: open && !disabled,
    ignoreOpenDialogs: false,
    onMatch: onConfirm,
  });
}
