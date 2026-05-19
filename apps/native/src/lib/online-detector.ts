import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { AppState, type AppStateStatus } from "react-native";
import type { OnlineDetector } from "@tanstack/offline-transactions";

// Replacement for `@tanstack/offline-transactions`' ReactNativeOnlineDetector,
// which has two race conditions on its internal `wasConnected` field that
// leave the offline executor's outbox stuck after airplane-mode-off
// (upstream issue TanStack/db#1490). Symptom: pending transactions don't
// retry on reconnect until something else triggers `executeAll` — a new
// recordEvent call, app foreground (AppState.active), or app restart.
//
// This implementation mirrors the upstream WebOnlineDetector's design:
//   - notify on every "online" event from the source (no edge detection)
//   - no async state probe at startup (no `NetInfo.fetch()` race)
//   - subscribers (the executor) dedupe via their internal `isExecuting`
//
// RN can't fully match WebOnlineDetector — `NetInfo` has no synchronous
// `isOnline()` equivalent, so we still cache `connected`. The discipline
// is to update the cache *before* notifying and not rely on it for
// transition detection. Drop this file and the `onlineDetector:` override
// in `canvass-events.ts` when upstream ships a fix.
export class FixedReactNativeOnlineDetector implements OnlineDetector {
  private listeners = new Set<() => void>();
  private netInfoUnsubscribe: (() => void) | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  // Optimistic until the first NetInfo event arrives. Matches upstream.
  // We deliberately skip NetInfo.fetch() — that's the cause of the
  // async-overwrite race in #1490.
  private connected = true;

  constructor() {
    this.netInfoUnsubscribe = NetInfo.addEventListener((state) => {
      const next = toConnectivityState(state);
      this.connected = next;
      if (next) this.notify();
    });
    this.appStateSubscription = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active") this.notify();
    });
  }

  isOnline(): boolean {
    return this.connected;
  }

  notifyOnline(): void {
    this.notify();
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  dispose(): void {
    this.netInfoUnsubscribe?.();
    this.appStateSubscription?.remove();
    this.listeners.clear();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.warn("FixedReactNativeOnlineDetector listener error:", err);
      }
    }
  }
}

function toConnectivityState(state: NetInfoState): boolean {
  return !!state.isConnected && state.isInternetReachable !== false;
}
