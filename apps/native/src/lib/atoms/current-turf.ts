import { atom } from "jotai";

// Tracks the currently active turf. Set when entering a turf,
// read by Settings to enable/disable the Sync button.
export const currentTurfIdAtom = atom<string | null>(null);
