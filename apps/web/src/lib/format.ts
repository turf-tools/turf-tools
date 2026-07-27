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

// Compact intra-day time (h:mm AM/PM) — launch-day walk activity is
// same-day, so the clock matters more than the calendar.
export function formatTime(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
}
