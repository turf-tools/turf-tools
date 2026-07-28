import type { ReactNode } from "react";
import { tintStyle } from "~/components/badge";
import { GREEN, RED } from "~/lib/palette";
import { cn } from "~/lib/utils";

// Message cards for dialogs and forms (errors, success confirmations),
// on the badge tint system with the scheme red/green. Unlike badges
// these carry a border — multi-line prose on a light tint needs the
// frame to read as a discrete callout (set --badge-border-alpha to 0
// at /badges to preview borderless).
const TONE_COLORS = {
  error: RED,
  success: GREEN,
};

export function Callout({
  tone,
  className,
  children,
}: {
  tone: keyof typeof TONE_COLORS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={cn("badge-tint badge-border rounded-md border px-3 py-2 text-sm", className)}
      style={tintStyle(TONE_COLORS[tone])}
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
