import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

// Bundles a dialog's open flag with a TanStack mutation. Removes the
// per-dialog boilerplate of pairing `useState(false)` with `useMutation`,
// remembering to call `mutation.reset()` on close, and wiring
// `setOpen(false)` into the success path.
//
// Returns:
//   - `isOpen` / `open` / `close` / `onOpenChange` — drives the dialog
//   - `mutate` / `isPending` / `error` — drives the dialog's action
//     button (`<Button loading={pending} />`) and inline error block
//
// Closing the dialog (cancel, esc, click-outside, or success) clears any
// stale error so it doesn't survive into the next open.
export function useDialogMutation<TInput, TOutput>(opts: {
  mutationFn: (input: TInput) => Promise<TOutput>;
  onSuccess?: (data: TOutput, input: TInput) => void | Promise<void>;
  onError?: (error: Error, input: TInput) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: opts.mutationFn,
    // Await onSuccess so callers can defer the close until any post-success
    // navigation/route transition has settled. Without this, a `void
    // navigate(...)` inside onSuccess can leave the modal closed but the
    // URL still on the previous id for a frame, briefly rendering the old
    // entity. Visible under CPU pressure (e.g. screen share).
    onSuccess: async (data, input) => {
      await opts.onSuccess?.(data, input);
      setIsOpen(false);
    },
    onError: opts.onError,
  });

  return {
    isOpen,
    open: () => {
      mutation.reset();
      setIsOpen(true);
    },
    close: () => setIsOpen(false),
    onOpenChange: (next: boolean) => {
      mutation.reset();
      setIsOpen(next);
    },
    mutate: mutation.mutate,
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    reset: mutation.reset,
  };
}
