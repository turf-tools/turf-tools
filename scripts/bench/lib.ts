// Shared measurement plumbing for the bench suites: Server-Timing parsing,
// medians, the results.jsonl row shape, and console formatting. Suites own
// their endpoints and request bodies; report.ts pivots the shared rows.

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export type Measurement = {
  wallMs: number;
  bytes: number;
  phases: Record<string, number>; // parsed Server-Timing (query, total, …)
};

export type ResultRow = {
  ts: string;
  env: string;
  label: string;
  org: string;
  url: string;
  scenario: string;
  endpoint: string;
  iterations: number;
  coldMs: number;
  warmMs: number; // median wall of warm iterations
  phases: Record<string, number>; // median warm server phases
  bytes: number;
};

export type RunContext = { env: string; label: string; org: string; url: string };

const RESULTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "results");
export const RESULTS_FILE = resolve(RESULTS_DIR, "results.jsonl");

export function parseServerTiming(header: string | null): Record<string, number> {
  const phases: Record<string, number> = {};
  if (!header) return phases;
  for (const part of header.split(",")) {
    const m = part.trim().match(/^([\w-]+);dur=([\d.]+)$/);
    if (m) phases[m[1]!] = Number(m[2]);
  }
  return phases;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Median of each phase across warm iterations, keyed by phase name.
export function medianPhases(measurements: Measurement[]): Record<string, number> {
  const keys = new Set(measurements.flatMap((m) => Object.keys(m.phases)));
  const out: Record<string, number> = {};
  for (const key of keys) {
    const vals = measurements.map((m) => m.phases[key]).filter((v): v is number => v != null);
    if (vals.length) out[key] = median(vals);
  }
  return out;
}

export function toRow(
  ctx: RunContext,
  scenario: string,
  endpoint: string,
  all: Measurement[],
): ResultRow {
  const warm = all.length > 1 ? all.slice(1) : all;
  return {
    ts: new Date().toISOString(),
    ...ctx,
    scenario,
    endpoint,
    iterations: all.length,
    coldMs: all[0]!.wallMs,
    warmMs: median(warm.map((m) => m.wallMs)),
    phases: medianPhases(warm),
    bytes: all[all.length - 1]!.bytes,
  };
}

export function appendRow(row: ResultRow): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS_FILE, JSON.stringify(row) + "\n");
}

export const fmtMs = (ms: number | undefined) =>
  ms == null ? chalk.gray("—") : `${ms.toFixed(0)}ms`;
export const fmtBytes = (b: number) =>
  b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)}MB` : `${(b / 1_000).toFixed(1)}kB`;

export function printRow(row: ResultRow) {
  const phases = row.phases;
  console.log(
    `  ${row.endpoint.padEnd(10)}` +
      ` warm ${chalk.bold(fmtMs(row.warmMs).padStart(8))}` +
      `  cold ${fmtMs(row.coldMs).padStart(8)}` +
      `  query ${fmtMs(phases.query).padStart(8)}` +
      `  server ${fmtMs(phases.total).padStart(8)}` +
      `  ${fmtBytes(row.bytes).padStart(8)}`,
  );
}

export async function checkHealth(url: string): Promise<void> {
  const health = await fetch(`${url}/healthcheck`).catch(() => null);
  if (!health?.ok) {
    console.error(chalk.red(`no data server at ${url} — is it running / tunneled?`));
    process.exit(1);
  }
}
