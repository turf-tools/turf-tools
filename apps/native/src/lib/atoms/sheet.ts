import { atom } from "jotai";

// Signal atom: set to true when navigating back to the list screen
// and the sheet should auto-expand. The list screen reads and resets it.
export const openSheetAtom = atom(false);
