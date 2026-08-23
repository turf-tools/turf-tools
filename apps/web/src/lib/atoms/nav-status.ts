import { atom } from "jotai";

export type NavStatusKind = "success" | "error" | "warning" | "info";
export type NavStatus = { message: string; kind: NavStatusKind; nonce: number };

// Last-writer-wins status line rendered in the top nav. `nonce` makes every
// write a distinct value so re-showing the same message restarts the fade
// timer. Stale content is hidden, not cleared — NavStatus keeps the last
// message mounted through its fade-out.
export const navStatusAtom = atom<NavStatus | null>(null);
