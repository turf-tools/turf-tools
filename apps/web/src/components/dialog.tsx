import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

// Soft-blocks click-outside dismiss when the dialog body contains a
// <form>. Confirmation dialogs (delete, etc — no form) keep click-outside
// as a fast dismiss; form dialogs treat outside-press as a near-miss so
// in-progress edits (text inputs, dropdown picks) aren't lost. Esc,
// Cancel, and programmatic close (mutation success) still close.
const DialogProtectContext = createContext<{ setProtected: (next: boolean) => void } | null>(null);

function Dialog({ open, onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  const [isProtected, setProtected] = useState(false);

  useEffect(() => {
    if (!open) setProtected(false);
  }, [open]);

  const handleOpenChange: NonNullable<DialogPrimitive.Root.Props["onOpenChange"]> = (
    nextOpen,
    eventDetails,
  ) => {
    if (!nextOpen && isProtected && eventDetails.reason === "outside-press") return;
    onOpenChange?.(nextOpen, eventDetails);
  };

  return (
    <DialogProtectContext.Provider value={{ setProtected }}>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />
    </DialogProtectContext.Provider>
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger {...props} />;
}

// Never refocus the trigger on close. base-ui's `finalFocus` only
// knows the close-interaction type, not how the dialog was opened — so
// a mouse-opened, keyboard-closed flow (Enter on Done) would otherwise
// leave a visible :focus-visible ring on the trigger. Trade-off: pure
// Tab-only users lose return-to-trigger after dialog close, which is
// rare in this app vs the visual cost of stray rings.
const FINAL_FOCUS_NONE = (): boolean => false;

function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  const ctx = useContext(DialogProtectContext);
  const popupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctx) return;
    ctx.setProtected(popupRef.current?.querySelector("form") != null);
  }, [ctx]);

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
          "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          "transition-opacity duration-100 data-[ending-style]:duration-200",
        )}
      />
      <DialogPrimitive.Popup
        ref={popupRef}
        tabIndex={-1}
        // Focus an input if present so the user can start typing;
        // otherwise focus the popup itself (outline-none so no ring).
        // The Enter handler below makes the keyless popup still
        // dismissable without auto-focusing a button — keyboard-opened
        // dialogs would otherwise show a :focus-visible ring on Cancel.
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>("input, textarea") ?? popupRef.current
        }
        finalFocus={FINAL_FOCUS_NONE}
        // Default Enter clicks the first DialogClose (Cancel/Ok), so
        // confirm dialogs are still keyboard-dismissable. Skipped when
        // focus is in an input or tabbed-to button — those handle
        // Enter themselves.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          if (e.target !== e.currentTarget) return;
          const close = popupRef.current?.querySelector<HTMLButtonElement>("[data-dialog-close]");
          if (close) {
            e.preventDefault();
            close.click();
          }
        }}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-[0_0_20px_rgba(0,0,0,0.2)]",
          "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          "data-[starting-style]:scale-95",
          "transition-[opacity,transform] duration-100 data-[ending-style]:duration-200",
          "outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("mb-2 text-xl font-extrabold tracking-wide", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("mb-5 text-sm text-muted-foreground italic", className)}
      {...props}
    />
  );
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  // `data-dialog-close` lets DialogContent's Enter handler find this
  // button as the popup's default-action target.
  return <DialogPrimitive.Close {...props} data-dialog-close="" />;
}

export { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose };
