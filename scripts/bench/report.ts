// Pivot results.jsonl into the comparison table: rows are scenario ×
// endpoint, columns are env@label (the latest run of each), cells show
// median warm wall time with the server-side query phase in parens —
// wall−query gap is network/tunnel plus non-query server work.
//
// Usage
//   pnpm bench:report
//   pnpm bench:report --metric cold        # warm | cold | query | server
//   pnpm bench:report --label main         # only columns with this label

import { readFileSync } from "node:fs";
import chalk from "chalk";
import meow from "meow";
import { type ResultRow, RESULTS_FILE } from "./lib";

const cli = meow(
  `
  Usage
    $ pnpm bench:report [--metric warm|cold|query|server] [--label <label>]
`,
  {
    importMeta: import.meta,
    flags: {
      metric: { type: "string", default: "warm" },
      label: { type: "string" },
    },
  },
);

let lines: string[];
try {
  lines = readFileSync(RESULTS_FILE, "utf8").trim().split("\n");
} catch {
  console.error(chalk.red(`no results at ${RESULTS_FILE} — run pnpm bench first`));
  process.exit(1);
}
let rows = lines.map((l) => JSON.parse(l) as ResultRow);
if (cli.flags.label) rows = rows.filter((r) => r.label === cli.flags.label);

// Latest row wins per (column, row-key) — reruns supersede.
const columnOf = (r: ResultRow) => `${r.env}@${r.label}`;
const keyOf = (r: ResultRow) => `${r.scenario}/${r.endpoint}`;
const latest = new Map<string, ResultRow>();
for (const r of rows) latest.set(`${columnOf(r)}|${keyOf(r)}`, r);

const columns = [...new Set([...latest.values()].map(columnOf))];
const keys = [...new Set([...latest.values()].map(keyOf))];

function cell(r: ResultRow | undefined): string {
  if (!r) return "—";
  const metric = { warm: r.warmMs, cold: r.coldMs, query: r.phases.query, server: r.phases.total }[
    cli.flags.metric as "warm" | "cold" | "query" | "server"
  ];
  if (metric == null) return "—";
  const query =
    cli.flags.metric === "warm" && r.phases.query != null ? ` (${r.phases.query.toFixed(0)}q)` : "";
  return `${metric.toFixed(0)}ms${query}`;
}

const rowHeader = "scenario/endpoint";
const width0 = Math.max(rowHeader.length, ...keys.map((k) => k.length)) + 2;
const widths = columns.map((c) => Math.max(c.length, 14) + 2);

console.log(chalk.gray(`metric: ${cli.flags.metric} (median; q = server query phase)\n`));
console.log(
  chalk.bold(rowHeader.padEnd(width0)) +
    columns.map((c, i) => chalk.bold(c.padStart(widths[i]!))).join(""),
);
for (const key of keys) {
  const line =
    key.padEnd(width0) +
    columns.map((c, i) => cell(latest.get(`${c}|${key}`)).padStart(widths[i]!)).join("");
  console.log(line);
}
