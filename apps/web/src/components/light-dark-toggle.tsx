import { useAtom } from "jotai";
import { MoonStar, Sun } from "lucide-react";
import { useEffect } from "react";
import { darkAtom } from "~/lib/atoms/theme";
import { cn } from "~/lib/utils";

// Circular light/dark mode toggle. Owns the side effect of mirroring
// `darkAtom` to the `.dark` class on <html> so Tailwind's dark variants
// activate. Intended to live in the TopBar alongside other user chrome.
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
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-4" /> : <MoonStar className="size-4" />}
    </button>
  );
}
