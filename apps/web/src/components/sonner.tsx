import { useAtomValue } from "jotai";
import { CircleCheck, Info, Loader2, Ban, TriangleAlert } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { darkAtom } from "~/lib/atoms/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const dark = useAtomValue(darkAtom);

  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <Ban className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      position="bottom-right"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "pl-5!",
          title: "font-normal! text-sm",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
