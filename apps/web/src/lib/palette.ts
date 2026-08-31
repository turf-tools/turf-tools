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

// Status trio thresholds shared by the turf board, Progress, and Reports:
// red = barely started, yellow = underway, green = mostly done.
export function progressColor(pct: number) {
  return pct <= 25 ? RED : pct <= 75 ? YELLOW : GREEN;
}

// Discrete 3-band magnitude scale — pink → purple → blue: the one
// Observable10 hue-chain that avoids the RYG status hues entirely
// (green/yellow mean done/underway next door on Progress), falls
// monotonically in CIELAB lightness ("darker = more" actually orders),
// and rotates through adjacent hues. Same banding rule as the RYG trio.
export function rateColor(t: number) {
  return t <= 0.25 ? PINK : t <= 0.75 ? PURPLE : BLUE;
}

// Color-scale domain for contact rate: door-knocking contact rates live
// in 0-20% essentially universally, so a 0-100% scale washes everything
// into the bottom band. Shared by Results and Reports so a given rate
// reads as the same color everywhere.
export const CONTACT_RATE_MAX = 0.2;
