import { useRef, useState } from "react";

// base-ui's DropdownMenuRadioGroup updates `value` synchronously on
// click, but the menu's close animation runs over the next frame —
// so for one frame the user sees the radio check snap to the new
// item before the menu disappears. Reads as a flash. The fix is to
// stage the new value in a ref, fire `setOpen(false)` to close the
// menu, and only call the consumer's commit function after the
// menu has fully unmounted (`onOpenChangeComplete` with isOpen=false).
//
// Encapsulates that dance so call sites don't have to repeat it
// each time. Spread `menu` onto DropdownMenu and `radio` onto
// DropdownMenuRadioGroup; `value` still goes on the radio group
// directly since it's caller state, not hook state.
//
//   const dd = useDeferredRadioDropdown({ onCommit: setActiveId });
//   <DropdownMenu {...dd.menu}>
//     ...
//     <DropdownMenuRadioGroup {...dd.radio} value={value ?? ""}>
//
// The commit value is whatever the radio group emits (a string).
// Consumers that use sentinel values ("" → null, "ALL" → null,
// etc.) handle that translation inside their `onCommit`.
export function useDeferredRadioDropdown({ onCommit }: { onCommit: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const pendingValueRef = useRef<string | undefined>(undefined);
  // `open` is also exposed at the top level for callers that need
  // to gate other UI on the dropdown's state (e.g. a global outside-
  // click handler that should suppress while a dropdown is up).
  return {
    open,
    menu: {
      open,
      onOpenChange: setOpen,
      onOpenChangeComplete: (isOpen: boolean) => {
        if (!isOpen && pendingValueRef.current !== undefined) {
          const v = pendingValueRef.current;
          pendingValueRef.current = undefined;
          onCommit(v);
        }
      },
    },
    radio: {
      onValueChange: (v: string) => {
        pendingValueRef.current = v;
        setOpen(false);
      },
    },
  };
}
