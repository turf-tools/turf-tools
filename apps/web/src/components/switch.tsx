import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full",
        "border border-transparent",
        "transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[checked]:bg-primary",
        "data-[unchecked]:bg-muted",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow ring-0",
          "transition-transform",
          "data-[checked]:translate-x-[1.125rem]",
          "data-[unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
