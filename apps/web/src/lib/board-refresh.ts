// Keeps the turfs board's walks query current on any connection. One
// refresh loop owns the query: each attempt has a deadline, network
// failures retry until one gets through, and triggers (SSE nudges and
// reconnects) wake the loop instead of fetching on their own. The query
// stays "fetching" for as long as the loop is trying, so the global
// spinner is on whenever the board may be behind.
//
// Module-level state: one board page is mounted at a time.

import { ORPCError } from "@orpc/client";
import { focusManager, type QueryClient, type QueryFunctionContext } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

export const ATTEMPT_DEADLINE_MS = 8_000;
const RETRY_WAITS_MS = [1_000, 2_000, 5_000];
export const POLL_STREAM_UP_MS = 30_000;
export const POLL_STREAM_DOWN_MS = 10_000;
// Brief reconnects (the SSE retry gap) keep the slow poll.
export const STREAM_DOWN_GRACE_MS = 10_000;
// The server pings every 25s; this long without hearing anything means
// the stream is dead even if the browser still reports it open.
export const STREAM_SILENT_MS = 60_000;
const SILENCE_CHECK_MS = 15_000;

const WALKS_KEY = ["walks"] as const;

// Gateway statuses are a proxy talking, not our server.
const GATEWAY_STATUSES = new Set([502, 503, 504]);

// Retry unless our server answered; its errors keep the query's normal
// retry handling.
function isTransient(error: unknown): boolean {
  return !(error instanceof ORPCError) || GATEWAY_STATUSES.has(error.status);
}

const waits = new Set<() => void>();
// A wake that arrived while an attempt was running.
let wokeDuringAttempt = false;

function takeWake(): boolean {
  const woke = wokeDuringAttempt;
  wokeDuringAttempt = false;
  return woke;
}

async function withDeadline<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
): Promise<T> {
  outer.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(outer.reason);
  outer.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("board refresh deadline")),
    ATTEMPT_DEADLINE_MS,
  );
  try {
    return await attempt(controller.signal);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", forward);
  }
}

// Ends early on a wake, the tab becoming visible, or the browser coming
// back online. Once the time is up it still holds while the tab is
// hidden, so a pocketed phone makes no requests.
function waitBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      if (focusManager.isFocused()) finish();
    }, ms);
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) finish();
    });
    const hasWindow = typeof window !== "undefined";
    if (hasWindow) window.addEventListener("online", finish);
    signal.addEventListener("abort", abort, { once: true });
    waits.add(finish);
    function cleanup() {
      clearTimeout(timer);
      unsubscribeFocus();
      if (hasWindow) window.removeEventListener("online", finish);
      signal.removeEventListener("abort", abort);
      waits.delete(finish);
    }
  });
}

function retryUntilThrough<T>(attempt: (signal: AbortSignal) => Promise<T>) {
  return async ({ signal }: QueryFunctionContext): Promise<T> => {
    for (let failures = 0; ; failures++) {
      try {
        return await withDeadline(attempt, signal);
      } catch (error) {
        if (signal.aborted || !isTransient(error)) throw error;
      }
      if (takeWake()) continue;
      const wait = RETRY_WAITS_MS[Math.min(failures, RETRY_WAITS_MS.length - 1)];
      await waitBeforeRetry(wait, signal);
    }
  };
}

// Live-query options layered over the plain walks query. Only the board's
// observers use them; the route loader keeps the plain options so a bad
// connection can't hang navigation.
export function boardRefreshOptions<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  streamUp: boolean,
) {
  return {
    queryFn: retryUntilThrough(attempt),
    networkMode: "always" as const,
    refetchInterval: streamUp ? POLL_STREAM_UP_MS : POLL_STREAM_DOWN_MS,
  };
}

// The one entry point for triggers. A running request isn't cancelled:
// it finishes, then one more fetch runs, since it was sent before the
// change it's being woken for.
export function wakeBoard(queryClient: QueryClient) {
  if (waits.size > 0) {
    for (const finish of waits) finish();
    return;
  }
  if (queryClient.isFetching({ queryKey: WALKS_KEY }) > 0) {
    wokeDuringAttempt = true;
    return;
  }
  void queryClient.invalidateQueries({ queryKey: WALKS_KEY });
}

// Runs the follow-up fetch for a wake that landed mid-request, including
// requests the loop didn't start (the route loader's).
function watchSettles(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== WALKS_KEY[0]) return;
    if (event.action.type !== "success" && event.action.type !== "error") return;
    if (takeWake()) void queryClient.invalidateQueries({ queryKey: WALKS_KEY });
  });
}

// Stream state, shared by every observer so they switch poll cadence
// together.
let streamUp = true;
let downTimer: ReturnType<typeof setTimeout> | null = null;
const streamListeners = new Set<() => void>();

function setStreamUp(up: boolean) {
  if (streamUp === up) return;
  streamUp = up;
  for (const listener of streamListeners) listener();
}

function markStream(connected: boolean) {
  if (connected) {
    if (downTimer) clearTimeout(downTimer);
    downTimer = null;
    setStreamUp(true);
  } else if (!downTimer && streamUp) {
    downTimer = setTimeout(() => {
      downTimer = null;
      setStreamUp(false);
    }, STREAM_DOWN_GRACE_MS);
  }
}

function resetStream() {
  if (downTimer) clearTimeout(downTimer);
  downTimer = null;
  setStreamUp(true);
}

export function isStreamUp(): boolean {
  return streamUp;
}

function subscribeStream(listener: () => void): () => void {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
}

export function useStreamUp(): boolean {
  return useSyncExternalStore(subscribeStream, isStreamUp, () => true);
}

// Opens the board's SSE stream and wires it to the loop. Returns the
// teardown.
export function connectBoard(url: string, queryClient: QueryClient): () => void {
  let source: EventSource;
  let lastHeard = Date.now();
  const heard = () => {
    lastHeard = Date.now();
  };
  const open = () => {
    source = new EventSource(url);
    source.onopen = () => {
      heard();
      markStream(true);
      wakeBoard(queryClient);
    };
    source.onmessage = () => {
      heard();
      wakeBoard(queryClient);
    };
    source.addEventListener("ping", heard);
    source.onerror = () => {
      if (source.readyState !== EventSource.OPEN) markStream(false);
    };
  };
  open();
  // Also revives a stream EventSource gave up on after a non-200 response.
  const silenceCheck = setInterval(() => {
    if (!focusManager.isFocused() || Date.now() - lastHeard < STREAM_SILENT_MS) return;
    source.close();
    markStream(false);
    heard();
    open();
  }, SILENCE_CHECK_MS);
  // Hidden tabs throttle timers; restart the clock so a resumed tab
  // isn't judged on time it spent hidden.
  const unsubscribeFocus = focusManager.subscribe((focused) => {
    if (focused) heard();
  });
  const unwatch = watchSettles(queryClient);
  return () => {
    clearInterval(silenceCheck);
    unsubscribeFocus();
    unwatch();
    source.close();
    resetStream();
    wokeDuringAttempt = false;
  };
}
