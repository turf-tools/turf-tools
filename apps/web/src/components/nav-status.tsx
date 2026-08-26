import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { tintStyle } from "~/components/badge";
import { Icon } from "~/components/icon";
import { navStatusAtom, type NavStatusKind } from "~/lib/atoms/nav-status";
import type { IconName } from "~/lib/icon-names";
import { RED, YELLOW } from "~/lib/palette";
import { cn } from "~/lib/utils";

const HOLD_MS = 3000;

// Confirmations (success/info) are the common case and stay quiet — plain
// muted text. Problems (error/warning) are rare and should interrupt, so
// they render as badge-tinted chips.
const TREATMENTS: Record<NavStatusKind, { icon: IconName | null; hue: string | null }> = {
  success: { icon: "check", hue: null },
  info: { icon: null, hue: null },
  error: { icon: "ban", hue: RED },
  warning: { icon: "triangle-alert", hue: YELLOW },
};

// Transient feedback in the top nav, written via notify(). Fades in on
// each write, holds, fades out; the last message stays mounted so the
// fade-out has content.
export function NavStatus({ className }: { className?: string }) {
  const status = useAtomValue(navStatusAtom);
  const [visible, setVisible] = useState(false);
  const last = useRef<{ message: string; kind: NavStatusKind } | null>(null);
  if (status) last.current = { message: status.message, kind: status.kind };

  useEffect(() => {
    if (!status) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [status]);

  const s = last.current;
  const t = s ? TREATMENTS[s.kind] : null;
  return (
    <div
      aria-live="polite"
      style={t?.hue ? tintStyle(t.hue) : undefined}
      className={cn(
        "pointer-events-none flex items-center gap-1.5 text-sm",
        "transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
        t?.hue ? "badge-tint rounded-md px-2.5 py-1.5" : "text-muted-foreground",
        className,
      )}
    >
      {s && t ? (
        <>
          {t.icon ? <Icon name={t.icon} className="size-4 shrink-0" /> : null}
          {s.message}
        </>
      ) : null}
    </div>
  );
}
