// The app's categorical palette — currently d3's schemeObservable10,
// swappable by editing this file (plus the two mirrored hues in
// styles.css, see below). Semantic reservations: RED/YELLOW/GREEN carry
// status and segment-verb meaning app-wide; BLUE floats between
// semantic (turfs live/pending) and categorical use (Single Select);
// the rest are free for categorical coding.
//
// styles.css mirrors RED and GREEN as --palette-red / --palette-green
// for the --destructive / --success tokens — keep them in sync.
import { schemeObservable10 } from "d3-scale-chromatic";

export const BLUE = schemeObservable10[0]!;
export const YELLOW = schemeObservable10[1]!;
export const RED = schemeObservable10[2]!;
export const TEAL = schemeObservable10[3]!;
export const GREEN = schemeObservable10[4]!;
export const PINK = schemeObservable10[5]!;
export const PURPLE = schemeObservable10[6]!;
export const LIGHT_BLUE = schemeObservable10[7]!;
export const BROWN = schemeObservable10[8]!;
export const GRAY = schemeObservable10[9]!;

// Scheme order, for index-based assignment (zone fills).
export const PALETTE = [BLUE, YELLOW, RED, TEAL, GREEN, PINK, PURPLE, LIGHT_BLUE, BROWN, GRAY];
