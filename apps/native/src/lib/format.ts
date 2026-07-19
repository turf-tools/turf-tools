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
