// Display formatting utilities. These transform data for presentation
// without modifying the underlying values.

import type { TurfDataPerson } from "@turf-tools/db/schema";

// Convert "JOHN SMITH" → "John Smith". Works on any all-caps or mixed-case
// string. Doesn't modify the source data — just for display.
export function toTitleCase(str: string | null | undefined): string {
  if (!str) return "";
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Compute integer age from an ISO `YYYY-MM-DD` date_of_birth string.
export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const ts = Date.parse(dob.trim());
  if (Number.isNaN(ts)) return null;
  const ms = Date.now() - ts;
  if (ms < 0) return null;
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

// Full display name with the middle name reduced to an initial (no period).
export function formatPersonName(p: TurfDataPerson): string {
  const middle = (p.middleName ?? "").trim();
  const middleInitial = middle ? middle.charAt(0) : null;
  return (
    [p.firstName, middleInitial, p.lastName, p.nameSuffix].filter(Boolean).join(" ").trim() ||
    "Unknown"
  );
}

// "APT 3B" (or bare "3B") → "Apt 3B". FL/STE/BLDG designators keep their
// own meaning and render title-cased instead of being relabeled "Apt".
// Null for unit-less doors — callers pick their own fallback.
export function formatUnitLabel(unit: string | null | undefined): string | null {
  const raw = (unit ?? "").trim();
  if (!raw) return null;
  if (/^(FL|FLOOR|STE|SUITE|BLDG|BUILDING)\b/i.test(raw)) return toTitleCase(raw);
  const stripped = raw.replace(/^(APT|APARTMENT|UNIT|#)\s*/i, "").trim();
  return stripped ? `Apt ${stripped}` : null;
}

// Bare unit for the nav title: leading designator dropped, remainder
// as-is ("APT 3B" → "3B", "APT 7FL" → "7FL"). The separator dot carries
// the "this is a unit" meaning — no per-designator relabeling.
export function formatUnitShort(unit: string | null | undefined): string | null {
  const raw = (unit ?? "").trim();
  if (!raw) return null;
  return (
    raw.replace(/^(APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|BLDG|BUILDING|#)\s*/i, "").trim() || null
  );
}

// Display variants for the canonical `enrollment` values produced by the
// data pipeline (apps/data/src/transformations.py). `short` is the
// pill abbreviation; `label` is the long form for detail views.
export const ENROLLMENT_LABELS: ReadonlyArray<{
  value: string;
  short: string;
  label: string;
}> = [
  { value: "democratic", short: "Dem", label: "Democratic" },
  { value: "republican", short: "Rep", label: "Republican" },
  { value: "conservative", short: "Con", label: "Conservative" },
  { value: "working_families", short: "WFP", label: "Working Families" },
  { value: "independence", short: "Indepenence", label: "Independence" },
  { value: "green", short: "Green", label: "Green" },
  { value: "libertarian", short: "Libertarian", label: "Libertarian" },
  { value: "reform", short: "Reform", label: "Reform" },
  { value: "unaffiliated", short: "None", label: "Unaffiliated" },
  { value: "other", short: "Other", label: "Other" },
];

const ENROLLMENT_BY_VALUE = new Map(ENROLLMENT_LABELS.map((e) => [e.value, e]));

// Each formatter renders a single property as a short label fit for a
// pill. Returns "?" for null/missing.
export function formatAge(p: TurfDataPerson): string {
  const age = ageFromDob(p.dateOfBirth);
  return age != null ? String(age) : "?";
}

export function formatGender(p: TurfDataPerson): string {
  const g = (p.gender ?? "").trim();
  if (!g) return "?";
  return g.charAt(0).toUpperCase();
}

export function formatEnrollment(p: TurfDataPerson): string {
  const v = (p.enrollment ?? "").trim();
  return ENROLLMENT_BY_VALUE.get(v)?.short ?? "?";
}
