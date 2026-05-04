import { useEffect } from "react";

// Mod-Enter (⌘ on macOS, Ctrl elsewhere) fires the dialog's destructive
// confirm. Only active while `open` is true and `disabled` is false; the
// confirm dialog is responsible for gating on its own pending state.
export function useConfirmHotkey({
  open,
  disabled,
  onConfirm,
}: {
  open: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open || disabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      onConfirm();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, disabled, onConfirm]);
}
