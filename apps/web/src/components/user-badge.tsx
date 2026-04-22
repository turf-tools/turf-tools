import { MoonStar, Sun } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

// Right side of the TopBar: circular light/dark toggle + "who am I" avatar
// stub. Initial theme state mirrors the DOM's `.dark` class if we're on
// the client; defaults to light on SSR (hydration settles quickly).
export function UserBadge() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  const toggleDark = () => {
    document.documentElement.classList.toggle("dark");
    setDark((d) => !d);
  };

  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        onClick={toggleDark}
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
      <div
        className={cn(
          "flex size-8 items-center justify-center",
          "rounded-full bg-foreground",
          "text-xs font-medium text-background",
        )}
      >
        AU
      </div>
    </div>
  );
}
