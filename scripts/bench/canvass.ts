// Canvass read-path benchmark: the five /reports/* previews and
// /results/aggregate, org-wide (all campaigns, no filters) — the heaviest
// shape each endpoint serves and the one the reports page cold-loads.
// Same measurement conventions as bench.ts; rows append to the shared
// results.jsonl for before/after comparison via report.ts.
//
// Usage (from scripts/)
//   pnpm exec tsx bench/canvass.ts --org <slug>            # local
//   pnpm exec tsx bench/canvass.ts --org <slug> --label materialized
//   pnpm exec tsx bench/canvass.ts --org <slug> --endpoint people

import chalk from "chalk";
import meow from "meow";
import {
  type Measurement,
  appendRow,
  checkHealth,
  parseServerTiming,
  printRow,
  toRow,
} from "./lib";

const cli = meow(
  `
  Usage
    $ pnpm exec tsx bench/canvass.ts --org <slug> [options]

  Options
    --org         Org slug the data server should resolve (required)
    --url         Data server base URL (default http://localhost:8000)
    --env         Environment label for results: local | latitude | do (default local)
    --label       Code-state label, e.g. main, materialized (default main)
    --iterations  Requests per endpoint (default 5; first is cold)
    --endpoint    Only run matching endpoint(s); repeatable
`,
  {
    importMeta: import.meta,
    flags: {
      org: { type: "string", isRequired: true },
      url: { type: "string", default: "http://localhost:8000" },
      env: { type: "string", default: "local" },
      label: { type: "string", default: "main" },
      iterations: { type: "number", default: 5 },
      endpoint: { type: "string", isMultiple: true },
    },
  },
);

const { org, url, env, label, iterations } = cli.flags;
const ctx = { env, label, org, url };

const REPORT_KINDS = ["people", "responses", "attempts", "walks", "canvassers"] as const;

type Endpoint = { name: string; path: string; body: Record<string, unknown> };

const ENDPOINTS: Endpoint[] = [
  ...REPORT_KINDS.map((kind) => ({
    name: kind,
    path: `/reports/${kind}`,
    body: { orgSlug: org, format: "preview" },
  })),
  { name: "results", path: "/results/aggregate", body: { orgSlug: org, criteria: { steps: [] } } },
];

async function measure(endpoint: Endpoint): Promise<Measurement> {
  const t0 = performance.now();
  const res = await fetch(`${url}${endpoint.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(endpoint.body),
  });
  const body = await res.arrayBuffer();
  const wallMs = performance.now() - t0;
  if (!res.ok) {
    const text = new TextDecoder().decode(body).slice(0, 200);
    throw new Error(`${endpoint.path} → ${res.status}: ${text}`);
  }
  return {
    wallMs,
    bytes: body.byteLength,
    phases: parseServerTiming(res.headers.get("Server-Timing")),
  };
}

async function main() {
  await checkHealth(url);

  const only = cli.flags.endpoint ?? [];
  const endpoints = only.length ? ENDPOINTS.filter((e) => only.includes(e.name)) : ENDPOINTS;
  if (!endpoints.length) {
    console.error(chalk.red(`no endpoints match ${only.join(", ")}`));
    process.exit(1);
  }

  console.log(
    `${chalk.bold(env)} (${url}) org=${org} label=${chalk.bold(label)} iterations=${iterations}\n`,
  );
  console.log(
    `${chalk.cyan("canvass")} — ${chalk.gray("org-wide report previews + results aggregate")}`,
  );

  for (const endpoint of endpoints) {
    try {
      const measurements: Measurement[] = [];
      for (let i = 0; i < iterations; i++) measurements.push(await measure(endpoint));
      const row = toRow(ctx, "canvass", endpoint.name, measurements);
      printRow(row);
      appendRow(row);
    } catch (err) {
      console.log(
        `  ${endpoint.name.padEnd(10)} ${chalk.red("failed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

await main();
