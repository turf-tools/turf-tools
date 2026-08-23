import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

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
// Per-call `mutate(input, { onSuccess })` is awaited before the dialog
// closes — that's how delete-with-fallback flows ensure their navigate(...)
// settles before the modal disappears. The hook-level `opts.onSuccess`
// runs fire-and-forget: its returned Promise (settleMutation, navigate) is
// dropped so cache work overlaps with the close animation rather than
// holding the dialog open through it.
export function useDialogMutation<TInput, TOutput>(opts: {
  mutationFn: (input: TInput) => Promise<TOutput>;
  onSuccess?: (data: TOutput, input: TInput) => void | Promise<void>;
  onError?: (error: Error, input: TInput) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  // Ref so the latest opts.onSuccess closure is used each call without
  // re-creating `mutate` on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mutation = useMutation({
    mutationFn: opts.mutationFn,
    onError: opts.onError,
    // Errors render inline via `error` below; skip the global error status.
    meta: { errorHandled: true },
  });

  type PerCallOptions = Parameters<typeof mutation.mutate>[1];
  const mutate = useCallback(
    (input: TInput, options?: PerCallOptions) => {
      return mutation.mutate(input, {
        ...options,
        onSuccess: async (...args) => {
          const [data] = args;
          Promise.resolve(optsRef.current.onSuccess?.(data, input)).catch((e) => {
            console.error("useDialogMutation: opts.onSuccess threw", e);
          });
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
