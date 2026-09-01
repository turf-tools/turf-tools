// Query-latency benchmark against a data server, one scenario × endpoint at a
// time. Hits the (unauthenticated, network-internal) data service directly —
// locally on :8000, deployments through a tunnel:
//
//   Latitude:  ssh -N -L 18000:localhost:8000 <box>
//   DO k8s:    kubectl port-forward svc/data 18000:8000
//
// Each request reports two clocks: client wall time (includes tunnel/network)
// and the server's own Server-Timing phases (resolve/catalog/criteria/query/
// total), so tunnel overhead never pollutes the on-box numbers. Results
// append to results/results.jsonl for cross-environment comparison via
// report.ts.
//
// Usage
//   pnpm bench --org <slug>                                # local
//   pnpm bench --org <slug> --url http://localhost:18000 \
//     --env latitude --label main                          # tunneled
//   pnpm bench --org <slug> --scenario steps-narrow --scenario burst
//   pnpm bench --org <slug> --extra my-scenarios.json      # e.g. custom fields

import { readFileSync } from "node:fs";
import chalk from "chalk";
import meow from "meow";
import {
  type Measurement,
  type ResultRow,
  RESULTS_FILE,
  appendRow,
  checkHealth,
  parseServerTiming,
  printRow,
  toRow as toSharedRow,
} from "./lib";
import { SCENARIOS, type Criteria, type Scenario } from "./scenarios";

const cli = meow(
  `
  Usage
    $ pnpm bench --org <slug> [options]

  Options
    --org         Org slug the data server should resolve (required)
    --url         Data server base URL (default http://localhost:8000)
    --env         Environment label for results: local | latitude | do (default local)
    --label       Code-state label, e.g. main, cascade-rewrite (default main)
    --iterations  Requests per scenario × endpoint (default 5; first is cold)
    --scenario    Only run matching scenario(s); repeatable
    --extra       JSON file of extra scenarios: [{name, description?, criteria}]
`,
  {
    importMeta: import.meta,
    flags: {
      org: { type: "string", isRequired: true },
      url: { type: "string", default: "http://localhost:8000" },
      env: { type: "string", default: "local" },
      label: { type: "string", default: "main" },
      iterations: { type: "number", default: 5 },
      scenario: { type: "string", isMultiple: true },
      extra: { type: "string" },
    },
  },
);

const { org, url, env, label, iterations } = cli.flags;

const ENDPOINTS = {
  count: "/persons/count",
  cascade: "/persons/count-cascade",
  points: "/buildings/points",
} as const;
type Endpoint = keyof typeof ENDPOINTS;

async function measure(endpoint: Endpoint, criteria: Criteria): Promise<Measurement> {
  const t0 = performance.now();
  const res = await fetch(`${url}${ENDPOINTS[endpoint]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria, orgSlug: org }),
  });
  const body = await res.arrayBuffer();
  const wallMs = performance.now() - t0;
  if (!res.ok) {
    const text = new TextDecoder().decode(body).slice(0, 200);
    throw new Error(`${ENDPOINTS[endpoint]} → ${res.status}: ${text}`);
  }
  return {
    wallMs,
    bytes: body.byteLength,
    phases: parseServerTiming(res.headers.get("Server-Timing")),
  };
}

const toRow = (scenario: string, endpoint: string, all: Measurement[]) =>
  toSharedRow({ env, label, org, url }, scenario, endpoint, all);

async function runScenario(scenario: Scenario): Promise<ResultRow[]> {
  const endpoints = Object.keys(ENDPOINTS) as Endpoint[];
  const perEndpoint = new Map<string, Measurement[]>(endpoints.map((e) => [e, []]));
  const batch: Measurement[] = [];

  for (let i = 0; i < iterations; i++) {
    if (scenario.burst) {
      const t0 = performance.now();
      const results = await Promise.all(endpoints.map((e) => measure(e, scenario.criteria)));
      batch.push({ wallMs: performance.now() - t0, bytes: 0, phases: {} });
      results.forEach((m, j) => perEndpoint.get(endpoints[j]!)!.push(m));
    } else {
      for (const e of endpoints) {
        perEndpoint.get(e)!.push(await measure(e, scenario.criteria));
      }
    }
  }

  const rows = endpoints.map((e) => toRow(scenario.name, e, perEndpoint.get(e)!));
  if (scenario.burst) rows.push(toRow(scenario.name, "batch", batch));
  return rows;
}

async function main() {
  await checkHealth(url);

  let scenarios = [...SCENARIOS];
  if (cli.flags.extra) {
    const extra = JSON.parse(readFileSync(cli.flags.extra, "utf8")) as Scenario[];
    scenarios.push(...extra);
  }
  const only = cli.flags.scenario ?? [];
  if (only.length) scenarios = scenarios.filter((s) => only.includes(s.name));
  if (!scenarios.length) {
    console.error(chalk.red(`no scenarios match ${only.join(", ")}`));
    process.exit(1);
  }

  console.log(
    `${chalk.bold(env)} (${url}) org=${org} label=${chalk.bold(label)} iterations=${iterations}\n`,
  );

  for (const scenario of scenarios) {
    console.log(`${chalk.cyan(scenario.name)} — ${chalk.gray(scenario.description)}`);
    try {
      const rows = await runScenario(scenario);
      for (const row of rows) {
        printRow(row);
        appendRow(row);
      }
    } catch (err) {
      console.log(`  ${chalk.red("failed")}: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
  console.log(chalk.gray(`results appended to ${RESULTS_FILE}`));
}

await main();
