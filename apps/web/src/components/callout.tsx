import type { ReactNode } from "react";
import { tintStyle } from "~/components/badge";
import { GREEN, RED, YELLOW } from "~/lib/palette";
import { cn } from "~/lib/utils";

// Message cards for dialogs and forms (errors, success confirmations,
// still-running work), on the badge tint system with the scheme
// red/yellow/green — the same three the status badges use. Unlike badges
// these carry a border — multi-line prose on a light tint needs the
// frame to read as a discrete callout (set --badge-border-alpha to 0
// at /badges to preview borderless). The fourth tone, `neutral`, sits
// outside the tint system on the plain muted surface (the gray-pill
// combination) — for information the reader can't act on.
const TONE_COLORS = {
  error: RED,
  pending: YELLOW,
  success: GREEN,
};

export function Callout({
  tone,
  className,
  children,
}: {
  tone: keyof typeof TONE_COLORS | "neutral";
  className?: string;
  children: ReactNode;
}) {
  const tinted = tone !== "neutral";
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tinted ? "badge-tint badge-border" : "border-border bg-muted text-foreground/60",
        className,
      )}
      style={tinted ? tintStyle(TONE_COLORS[tone]) : undefined}
    >
      {children}
    </p>
  );
}

// Shorthand for the common dialog error slot.
export function DialogError({ error }: { error: string | null }) {
  if (!error) return null;
  return <Callout tone="error">{error}</Callout>;
}
