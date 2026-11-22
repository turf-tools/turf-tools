// Signs out a burst of turfs against a local dev server the way the
// native app does (scan, then walk open), holds them, then closes them.
// Watch the turfs board alongside with the console filtered to
// "[rpc] walks" to see each fetch the board makes.
//
//   pnpm exec tsx scripts/board-burst.ts "<campaign name>" [count=5] [gapMs=1500] [holdMs=20000]
//
// Picks turfs in that campaign with no open walk. Leaves closed walks
// (canvasser "Burst N") in the local database.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { db } from "@turf-tools/db";
import { sql } from "drizzle-orm";
import type { NativeRouter } from "../src/rpc";

const [campaignName, countArg = "5", gapArg = "1500", holdArg = "20000"] = process.argv.slice(2);
if (!campaignName) {
  console.error('usage: board-burst.ts "<campaign name>" [count] [gapMs] [holdMs]');
  process.exit(1);
}
const count = Number(countArg);
const gapMs = Number(gapArg);
const holdMs = Number(holdArg);
const baseUrl = process.env.BOARD_URL ?? "http://localhost:3000";

const native: RouterClient<NativeRouter> = createORPCClient(
  new RPCLink({ url: `${baseUrl}/api/native/rpc` }),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const log = (message: string) =>
  console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${message}`);

const result = await db.execute(sql`
  select t.turf_id, t.turf_code
  from app.turfs t
  join app.campaigns c using (campaign_id)
  where c.name = ${campaignName}
    and t.status = 'active'
    and not exists (
      select 1 from app.walks w where w.turf_id = t.turf_id and w.closed_at is null
    )
  order by t.turf_code
  limit ${count}
`);
// postgres-js returns the row array directly (no `.rows` wrapper).
const rows = result as unknown as Array<{ turf_id: string; turf_code: string }>;
if (rows.length < count) {
  console.error(`only ${rows.length} free active turfs in "${campaignName}"`);
  process.exit(1);
}

// One phone per turf: an open closes that phone's other walks.
const signOuts = rows.map((row, i) => ({
  ...row,
  name: `Burst ${i + 1}`,
  phone: `555-01${String(i).padStart(2, "0")}`,
}));

for (const s of signOuts) {
  await native.turfs.getByCode({ code: s.turf_code, attributed: false });
  log(`scan ${s.turf_code}`);
  await sleep(Math.min(400, gapMs));
  await native.walks.open({ turfId: s.turf_id, canvasserName: s.name, canvasserPhone: s.phone });
  log(`open ${s.turf_code} (${s.name})`);
  await sleep(gapMs);
}

log(`holding ${holdMs / 1000}s`);
await sleep(holdMs);

for (const s of signOuts) {
  await native.walks.close({ turfId: s.turf_id, canvasserPhone: s.phone });
  log(`close ${s.turf_code}`);
}
process.exit(0);
