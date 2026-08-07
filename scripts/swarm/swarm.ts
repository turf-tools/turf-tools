// Device swarm harness: simulates canvassing devices speaking the native
// app's real protocol through the public ingress — code redemption, turf
// payload pull, walk open, canvass-event pushes, sync pulls, walk close.
// Events are stamped inputType "swarm" so they're identifiable (and
// the whole run should target a disposable org anyway).
//
//   pnpm swarm --code AB12 --smoke                 # one device, one pass
//   pnpm swarm --code AB12 --code CD34 \
//     --devices 200 --duration 600 --ramp 120     # the real thing
//
// The real thing is meant to be run while watching the deployment —
// don't point it at a live org, and don't run it casually.

import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import chalk from "chalk";
import meow from "meow";

const cli = meow(
  `
  Usage
    $ pnpm swarm --code <turfCode> [--code <turfCode> ...] [options]

  Options
    --url            Deployment origin (required — no default, on purpose:
                     this harness writes events and opens walks wherever
                     it's pointed)
    --smoke          One device, one pass through every procedure, then exit
    --devices        Concurrent simulated devices (default 1)
    --duration       Seconds to sustain after ramp (default 300)
    --ramp           Seconds over which devices start (default 60)
    --pull-interval  Seconds between sync pulls per device (default 20)
    --event-interval Mean seconds between canvass events per device (default 90)
`,
  {
    importMeta: import.meta,
    flags: {
      url: { type: "string", isRequired: true },
      code: { type: "string", isMultiple: true, isRequired: true },
      smoke: { type: "boolean", default: false },
      devices: { type: "number", default: 1 },
      duration: { type: "number", default: 300 },
      ramp: { type: "number", default: 60 },
      pullInterval: { type: "number", default: 20 },
      eventInterval: { type: "number", default: 90 },
    },
  },
);

const { url, smoke, devices, duration, ramp, pullInterval, eventInterval } = cli.flags;
const codes = cli.flags.code;

// --- metrics -----------------------------------------------------------

const latencies = new Map<string, number[]>();
const errors = new Map<string, number>();

function record(procedure: string, ms: number, ok: boolean) {
  if (ok) {
    let arr = latencies.get(procedure);
    if (!arr) latencies.set(procedure, (arr = []));
    arr.push(ms);
  } else {
    errors.set(procedure, (errors.get(procedure) ?? 0) + 1);
  }
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function report() {
  console.log(
    `\n${chalk.bold("procedure".padEnd(22))}${"n".padStart(7)}${"p50".padStart(9)}${"p95".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}${"errors".padStart(8)}`,
  );
  const names = [...new Set([...latencies.keys(), ...errors.keys()])].sort();
  for (const name of names) {
    const sorted = [...(latencies.get(name) ?? [])].sort((a, b) => a - b);
    const err = errors.get(name) ?? 0;
    const cell = (v: number | undefined) => (v == null ? "—" : `${v.toFixed(0)}ms`);
    console.log(
      name.padEnd(22) +
        `${sorted.length}`.padStart(7) +
        cell(sorted.length ? quantile(sorted, 0.5) : undefined).padStart(9) +
        cell(sorted.length ? quantile(sorted, 0.95) : undefined).padStart(9) +
        cell(sorted.length ? quantile(sorted, 0.99) : undefined).padStart(9) +
        cell(sorted.at(-1)).padStart(9) +
        (err > 0 ? chalk.red(`${err}`.padStart(8)) : `${err}`.padStart(8)),
    );
  }
}

// --- client ------------------------------------------------------------

// One shared link; the wrapped fetch attributes timing to the procedure
// segment of the URL (".../rpc/canvass/appendResult" → canvass.appendResult).
const link = new RPCLink({
  url: `${url}/api/native/rpc`,
  fetch: async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const procedure = path.split("/rpc/")[1]?.replaceAll("/", ".") ?? path;
    const t0 = performance.now();
    try {
      const res = await fetch(input, init);
      record(procedure, performance.now() - t0, res.ok);
      return res;
    } catch (err) {
      record(procedure, performance.now() - t0, false);
      throw err;
    }
  },
});
// Untyped on purpose: this script lives outside the web app's type graph.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createORPCClient(link);

// --- device simulation -------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (mean: number) => mean * (0.5 + Math.random());

// A device walks its turf: each event targets the next person, door by
// door, starting at an offset so concurrent devices spread across the turf
// and the progress board grows the way a real canvass does.
type Walkabout = { turfId: string; persons: string[]; at: number };

async function bind(deviceIndex: number, code: string): Promise<Walkabout> {
  const turf = await client.turfs.getByCode({ code, attributed: true });
  if (!turf) throw new Error(`no active turf for code ${code}`);
  const data = await client.turfs.getData({ turfId: turf.turfId });
  if (!data) throw new Error(`no turf_data for ${turf.turfId}`);
  if (turf.scriptId) await client.scripts.get({ scriptId: turf.scriptId });
  const persons = data.buildings.flatMap((b: { doors: { persons: { personId: string }[] }[] }) =>
    b.doors.flatMap((d) => d.persons.map((p) => p.personId)),
  );
  return {
    turfId: turf.turfId,
    persons,
    at: persons.length ? (deviceIndex * 7) % persons.length : 0,
  };
}

// Mirrors the app's result shape exactly: personId only, advancing through
// the walk order like a canvasser moving door to door.
function makeEvent(walk: Walkabout, canvasser: { name: string; phone: string }) {
  const personId = walk.persons.length ? walk.persons[walk.at % walk.persons.length] : undefined;
  walk.at += 1;
  return {
    turfId: walk.turfId,
    personId,
    payload: { kind: "result" as const, outcome: "not_home" as const, responses: {} },
    createdAt: new Date().toISOString(),
    canvasserName: canvasser.name,
    canvasserPhone: canvasser.phone,
    inputType: "swarm",
    clientEventId: randomUUID(),
  };
}

async function device(index: number, stop: AbortSignal) {
  const canvasser = {
    name: `Load Device ${index}`,
    phone: `+1555${String(1000000 + index).slice(-7)}`,
  };
  const walk = await bind(index, codes[index % codes.length]!);
  const { walkId: _walkId } = await client.walks.open({
    turfId: walk.turfId,
    canvasserName: canvasser.name,
    canvasserPhone: canvasser.phone,
  });

  let cursor = 0;
  let nextPull = performance.now() + jitter(pullInterval * 1000);
  let nextEvent = performance.now() + jitter(eventInterval * 1000);
  while (!stop.aborted) {
    const now = performance.now();
    if (now >= nextEvent) {
      await client.canvass.appendResult(makeEvent(walk, canvasser)).catch(() => {});
      nextEvent = now + jitter(eventInterval * 1000);
    }
    if (now >= nextPull) {
      const res = await client.canvass.pull({ turfId: walk.turfId, cursor }).catch(() => null);
      if (res) cursor = res.cursor;
      nextPull = now + jitter(pullInterval * 1000);
    }
    await sleep(250);
  }
  // Staggered so teardown doesn't fire 200 simultaneous TLS handshakes from
  // one process — a client-side artifact real, unsynchronized phones can't
  // produce (it read as ~6.5s of fake close latency).
  await sleep(Math.random() * 5000);
  await client.walks
    .close({ turfId: walk.turfId, canvasserPhone: canvasser.phone })
    .catch(() => {});
}

// --- modes -------------------------------------------------------------

async function runSmoke() {
  console.log(chalk.bold(`smoke: one device against ${url} (code ${codes[0]})`));
  await client.healthcheck({});
  const canvasser = { name: "Load Smoke Device", phone: "+15550000000" };
  const walk = await bind(0, codes[0]!);
  console.log(`  bound turf ${walk.turfId} (${walk.persons.length} persons in walk order)`);
  await client.walks.open({
    turfId: walk.turfId,
    canvasserName: canvasser.name,
    canvasserPhone: canvasser.phone,
  });
  await client.canvass.appendResult(makeEvent(walk, canvasser));
  const pulled = await client.canvass.pull({ turfId: walk.turfId, cursor: 0 });
  console.log(`  pulled ${pulled.events.length} event(s), cursor ${pulled.cursor}`);
  await client.walks.close({ turfId: walk.turfId, canvasserPhone: canvasser.phone });
  report();
}

async function runLoad() {
  console.log(
    chalk.bold(
      `load: ${devices} devices, ${ramp}s ramp, ${duration}s hold, against ${url} — watch the deployment`,
    ),
  );
  const stop = new AbortController();
  const runners: Promise<void>[] = [];
  for (let i = 0; i < devices; i++) {
    const delay = (i / Math.max(1, devices - 1)) * ramp * 1000;
    runners.push(
      sleep(delay).then(() =>
        device(i, stop.signal).catch((err) => {
          record("device.fatal", 0, false);
          if (i < 3) console.error(chalk.red(`device ${i}: ${err}`));
        }),
      ),
    );
  }
  const progress = setInterval(() => {
    const total = [...latencies.values()].reduce((a, v) => a + v.length, 0);
    const errCount = [...errors.values()].reduce((a, v) => a + v, 0);
    console.log(`  ${total} requests, ${errCount} errors`);
  }, 10_000);
  await sleep((ramp + duration) * 1000);
  stop.abort();
  await Promise.all(runners);
  clearInterval(progress);
  report();
}

await (smoke ? runSmoke() : runLoad());
