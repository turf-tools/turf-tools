import { atom } from "jotai";
import type { TurfLink } from "@/lib/turf-link";

// Handoff from the scan modal or a tapped link to the landing screen: the
// source writes the parsed entry and dismisses; the landing screen consumes
// it into the form fields, clears it, and opens the turf — unless the host
// is empty (a link with only a code), which fills and waits. Not persisted
// — a scan is momentary by design.
export const scannedEntryAtom = atom<TurfLink | null>(null);

// Handoff from the landing screen to the identity sheet: a first open on
// a device with no canvasser parks the resolved turf here, and the
// sheet's Save completes the bind and navigates straight to the turf —
// so the landing never flashes back into view mid-flow. Cleared by the
// sheet on success, or by the landing on refocus (the decline path).
export type PendingOpen = { host: string; turfId: string };
export const pendingOpenAtom = atom<PendingOpen | null>(null);
