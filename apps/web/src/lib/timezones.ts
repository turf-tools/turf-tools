// Supported display timezones for the admin UI.
export const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
] as const;

export type DisplayTimezone = (typeof TIMEZONE_OPTIONS)[number]["value"];

export const DEFAULT_DISPLAY_TIMEZONE: DisplayTimezone = "America/New_York";

export function isDisplayTimezone(value: string): value is DisplayTimezone {
  return TIMEZONE_OPTIONS.some((o) => o.value === value);
}

// "2026-08-23" → "Aug 23, 2026". Split manually — Date parsing would
// re-interpret the day in UTC and shift it across midnight.
export function formatCanvassDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}

// Detect the browser's IANA timezone and map it to one of the four options.
// Exact match wins; otherwise fall back to the closest US zone by current
// UTC offset. Phoenix/Honolulu/etc. land on Mountain or Pacific.
export function detectDisplayTimezone(): DisplayTimezone {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (isDisplayTimezone(detected)) return detected;
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  if (offsetHours >= -4.5) return "America/New_York";
  if (offsetHours >= -5.5) return "America/Chicago";
  if (offsetHours >= -6.5) return "America/Denver";
  return "America/Los_Angeles";
}
