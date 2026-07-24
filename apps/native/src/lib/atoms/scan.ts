import { atom } from "jotai";
import type { ScannedEntry } from "@/lib/turf-qr";

// Handoff from the scan modal to the landing screen: the modal writes the
// parsed entry and dismisses; the landing screen consumes it into the form
// fields and clears it. Not persisted — a scan is momentary by design (the
// user still reviews the fields and hits Open).
export const scannedEntryAtom = atom<ScannedEntry | null>(null);
