import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";
import { useDelayedFlag } from "~/lib/use-delayed-flag";
import { cn } from "~/lib/utils";

type ButtonClickHandler = NonNullable<ButtonPrimitive.Props["onClick"]>;
type ButtonClickEvent = Parameters<ButtonClickHandler>[0];

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-normal whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-white hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary hover:text-primary/80",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
      // Press-shift affordance, on by default. Set `press="none"` for buttons
      // whose click also moves content (e.g. adding a list row), where the
      // shift reads as a jarring double-motion. (haspopup triggers never shift.)
      press: {
        shift: "active:not-aria-[haspopup]:translate-y-px",
        none: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      press: "shift",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    // While true, swap the first icon child for a spinner and disable
    // the button. Use for actions whose pending state belongs visually
    // attached to the click target rather than a far-away global
    // indicator.
    loading?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  press = "shift",
  loading = false,
  disabled,
  children,
  onClick,
  ...props
}: ButtonProps) {
  // Spinner is gated through `useDelayedFlag` so sub-100ms operations
  // never show one. During that pre-spinner window we *also* don't
  // set the `disabled` attribute — disabled buttons lose `:hover`
  // styles, which on variants like `destructive` (where hover changes
  // the bg) reads as a brief flash on click. Instead we no-op clicks
  // via the handler below, so the button still looks interactive
  // even though it can't fire again.
  const showSpinner = useDelayedFlag(loading);
  const handleClick: ButtonClickHandler = (e: ButtonClickEvent) => {
    if (loading) {
      // Block any in-flight re-click — including the implicit
      // form-submit a `type="submit"` button would otherwise trigger.
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <ButtonPrimitive
      data-slot="button"
      disabled={disabled || showSpinner}
      onClick={handleClick}
      className={cn(buttonVariants({ variant, size, press, className }))}
      {...props}
    >
      {showSpinner ? withLeadingSpinner(children) : children}
    </ButtonPrimitive>
  );
}

// Replace the first icon-shaped child (any React element) with a
// spinner; if there isn't one, prepend the spinner. This keeps the
// button's text + width stable across loading transitions.
function withLeadingSpinner(children: ReactNode): ReactNode {
  const spinner = <LoaderCircle key="__loading-spinner__" className="animate-spin" />;
  const arr = Children.toArray(children);
  const idx = arr.findIndex((c) => isValidElement(c));
  if (idx === -1) return [spinner, ...arr];
  return arr.map((c, i) => (i === idx ? spinner : c));
}

export { Button, buttonVariants };
