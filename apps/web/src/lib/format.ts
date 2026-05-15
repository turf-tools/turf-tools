// Formatters shared across the admin UI. Keep date output compact so it
// fits cleanly inside a Pill (MM/DD/YY).
export function formatDate(value: Date | string | null | undefined, timezone: string) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    timeZone: timezone,
  });
}
