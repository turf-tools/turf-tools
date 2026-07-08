import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// `"#rrggbb"` or `"#rgb"` → `[r, g, b]` in 0..255. Returns `[0, 0, 0]` on bad input.
export function parseHexRgb(css: string): [number, number, number] {
  let hex = css.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6) return [0, 0, 0];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

// Next default name for a scratch entity: `base` if free, else the lowest
// `"base N"` (N ≥ 2) not taken. Names aren't unique-constrained, so
// collisions are only cosmetic.
export function nextUntitledName(base: string, existing: ReadonlyArray<{ name: string }>): string {
  const taken = new Set(existing.map((e) => e.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// Render an ALL-CAPS voter-file string (name, address, city) as
// title case. Capitalizes the first letter of each word *and* of
// each segment after a hyphen or apostrophe — "O'BRIEN" → "O'Brien",
// "MARY-JANE" → "Mary-Jane". Returns "" for null/undefined/empty.
export function toTitleCase(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().replace(/(?:^|[\s\-'])\p{L}/gu, (c) => c.toUpperCase());
}
