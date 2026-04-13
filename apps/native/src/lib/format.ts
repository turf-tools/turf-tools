// Display formatting utilities. These transform data for presentation
// without modifying the underlying values.

// Convert "JOHN SMITH" → "John Smith". Works on any all-caps or mixed-case
// string. Doesn't modify the source data — just for display.
export function toTitleCase(str: string | null | undefined): string {
  if (!str) return "";
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
