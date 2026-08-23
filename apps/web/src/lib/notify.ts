import { createStore } from "jotai";
import { navStatusAtom, type NavStatusKind } from "~/lib/atoms/nav-status";

type Store = ReturnType<typeof createStore>;

// The root route's jotai store, registered at mount so non-React call sites
// (the global mutation onError, mutation callbacks) can write the nav
// status. Browser-only: mutations never run during SSR, so the store is
// always registered before the first notify call.
let store: Store | null = null;

export function __registerNotifyStore(s: Store) {
  store = s;
}

function write(kind: NavStatusKind, message: string) {
  store?.set(navStatusAtom, { kind, message, nonce: Date.now() });
}

// The app's transient feedback surface — renders in the top nav (NavStatus).
// success/info fade as quiet text; error/warning show as badge chips.
export const notify = {
  success: (message: string) => write("success", message),
  info: (message: string) => write("info", message),
  warning: (message: string) => write("warning", message),
  error: (message: string) => write("error", message),
};
