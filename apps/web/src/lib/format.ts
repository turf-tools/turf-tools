import { toTitleCase } from "./utils";

// Display name: "First M Last Suffix" — a middle name collapses to its
// bare initial when present, nothing otherwise. Shared by lookup (list +
// detail), the segment list view, and reports so names render the same
// everywhere.
export function formatPersonName(
  first: string | null | undefined,
  middle: string | null | undefined,
  last: string | null | undefined,
  suffix?: string | null,
): string {
  const trimmed = middle?.trim();
  const initial = trimmed ? trimmed[0]?.toUpperCase() : null;
  return [toTitleCase(first), initial, toTitleCase(last), toTitleCase(suffix)]
    .filter(Boolean)
    .join(" ");
}

// Formatters shared across the admin UI. Keep date output compact so it
// fits cleanly inside a Pill (MM/DD/YY).
export function formatDate(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "—";
  // A bare calendar date (YYYY-MM-DD, no time) carries no timezone — format it
  // from its own parts so it can't shift a day. `new Date("2024-11-05")` would
  // parse as UTC midnight and then render a day early in a behind-UTC zone.
  // Timestamps (Date objects / datetime strings) still convert into `timezone`.
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    timeZone: timezone,
  });
}

// MM/DD/YY h:mm AM/PM — for timestamps where the clock matters (imports).
export function formatDateTime(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "—";
  return `${formatDate(value, timezone)} ${formatTime(value, timezone)}`;
}

// MM/DD — for badge-sized contexts (the walked-date chip) where the
// year is noise.
export function formatMonthDay(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
}

// Compact intra-day time (hh:mm AM/PM, zero-padded hour so times align
// in columns) — launch-day walk activity is same-day, so the clock
// matters more than the calendar.
export function formatTime(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}
