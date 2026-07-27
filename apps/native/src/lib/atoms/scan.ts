import { atom } from "jotai";
import type { ScannedEntry } from "@/lib/turf-qr";

// Handoff from the scan modal to the landing screen: the modal writes the
// parsed entry and dismisses; the landing screen consumes it into the form
// fields and clears it. Not persisted — a scan is momentary by design (the
// user still reviews the fields and hits Open).
export const scannedEntryAtom = atom<ScannedEntry | null>(null);

// Handoff from the landing screen to the identity sheet: a first open on
// a device with no canvasser parks the resolved turf here, and the
// sheet's Save completes the bind and navigates straight to the turf —
// so the landing never flashes back into view mid-flow. Cleared by the
// sheet on success, or by the landing on refocus (the decline path).
export type PendingOpen = { host: string; turfId: string };
export const pendingOpenAtom = atom<PendingOpen | null>(null);
