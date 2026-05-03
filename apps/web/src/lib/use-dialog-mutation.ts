import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

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
//
// Both `opts.onSuccess` (always-runs cache work, etc.) and the per-call
// `mutate(input, { onSuccess })` callback are awaited before the dialog
// closes. This is what makes a `navigate(...)` inside either hook safe —
// the URL has settled by the time the modal goes away. Per-call hooks
// are the right home for things that depend on click-time state (e.g.
// "delete then go to the previous neighbor I computed at click time").
export function useDialogMutation<TInput, TOutput>(opts: {
  mutationFn: (input: TInput) => Promise<TOutput>;
  onSuccess?: (data: TOutput, input: TInput) => void | Promise<void>;
  onError?: (error: Error, input: TInput) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: opts.onSuccess,
    onError: opts.onError,
  });

  // Wrap mutate so the per-call onSuccess (if any) runs and is awaited
  // before the dialog closes. Order on success:
  //   1. mutationFn resolves
  //   2. opts.onSuccess (global) runs and is awaited by TanStack Query
  //   3. per-call onSuccess (this wrapper) runs and is awaited
  //   4. setIsOpen(false)
  type PerCallOptions = Parameters<typeof mutation.mutate>[1];
  const mutate = useCallback(
    (input: TInput, options?: PerCallOptions) => {
      return mutation.mutate(input, {
        ...options,
        onSuccess: async (...args) => {
          // Promise.resolve coerces both Promise and non-Promise return
          // values from the caller's onSuccess to something awaitable.
          await Promise.resolve(options?.onSuccess?.(...args));
          setIsOpen(false);
        },
      });
    },
    [mutation],
  );

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
    mutate,
    isPending: mutation.isPending,
    error: mutation.error?.message ?? null,
    reset: mutation.reset,
  };
}
