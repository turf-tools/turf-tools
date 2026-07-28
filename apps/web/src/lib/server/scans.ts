// In-memory scan signals: transient "an unattributed device is signing
// this turf out" hints, alive for minutes and meaningless after — so
// they live beside the SSE channels rather than in a table. Tables hold
// facts (walks, events); memory holds signals. Same single-process
// assumption and restart semantics as live.ts: a lost signal degrades
// to the poll/walk backbone. globalThis-anchored to survive the dev
// server's module re-evaluation.

type Scan = { scannedAt: Date; organizationId: string; campaignId: string };

// Prune horizon — comfortably past the client's 2-minute pending window,
// so the map stays bounded without a sweeper.
const MAX_AGE_MS = 10 * 60_000;

const g = globalThis as { __turfToolsScans?: Map<string, Scan> };
g.__turfToolsScans ??= new Map<string, Scan>();
const scans = g.__turfToolsScans;

export function recordScan(turfId: string, organizationId: string, campaignId: string) {
  scans.set(turfId, { scannedAt: new Date(), organizationId, campaignId });
}

// Current signals for an org (optionally campaign-scoped), pruning
// expired entries in passing.
export function scansForOrg(
  organizationId: string,
  campaignId?: string,
): { turfId: string; scannedAt: Date }[] {
  const now = Date.now();
  const out: { turfId: string; scannedAt: Date }[] = [];
  for (const [turfId, scan] of scans) {
    if (now - scan.scannedAt.getTime() > MAX_AGE_MS) {
      scans.delete(turfId);
      continue;
    }
    if (scan.organizationId !== organizationId) continue;
    if (campaignId && scan.campaignId !== campaignId) continue;
    out.push({ turfId, scannedAt: scan.scannedAt });
  }
  return out;
}
