import { useAtom } from "jotai";
import { Sun } from "lucide-react";
import { useEffect } from "react";
import { darkAtom } from "~/lib/atoms/theme";
import { cn } from "~/lib/utils";

// Circular theme toggle. Owns the side effect of mirroring `darkAtom` to
// the `.dark` class on <html>.
export function LightDarkToggle() {
  const [dark, setDark] = useAtom(darkAtom);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      className={cn(
        "flex size-8 items-center justify-center",
        "rounded-full border border-border",
        "text-muted-foreground",
        "hover:bg-muted hover:text-foreground",
      )}
      aria-label="Toggle theme"
    >
      <Sun className="size-4" />
    </button>
  );
}
