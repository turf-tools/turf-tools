import { ORPCError } from "@orpc/client";
import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  ATTEMPT_DEADLINE_MS,
  boardRefreshOptions,
  connectBoard,
  isStreamUp,
  STREAM_DOWN_GRACE_MS,
} from "../src/lib/board-refresh";

class FakeEventSource {
  static OPEN = 1;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private named = new Map<string, Array<() => void>>();
  constructor() {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.named.set(type, [...(this.named.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  nudge() {
    this.onmessage?.();
  }
  ping() {
    for (const listener of this.named.get("ping") ?? []) listener();
  }
  drop() {
    this.readyState = 0;
    this.onerror?.();
  }
}

// One pending request per call; aborting rejects it like fetch does.
type Call = { signal: AbortSignal; resolve: (value: number) => void; reject: (e: unknown) => void };

let calls: Call[];
let queryClient: QueryClient;
let observer: QueryObserver<number>;
let stopObserving: () => void;
let disconnect: () => void;

const attempt = (signal: AbortSignal) =>
  new Promise<number>((resolve, reject) => {
    calls.push({ signal, resolve, reject });
    signal.addEventListener("abort", () => reject(signal.reason));
  });

const flush = () => vi.advanceTimersByTimeAsync(0);
const stream = () => FakeEventSource.instances.at(-1)!;
const fetchStatus = () => observer.getCurrentResult().fetchStatus;

async function openBoard() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0 } } });
  queryClient.mount();
  disconnect = connectBoard("/live", queryClient);
  observer = new QueryObserver(queryClient, {
    queryKey: ["walks", null],
    ...boardRefreshOptions(attempt, true),
  });
  stopObserving = observer.subscribe(() => {});
  await flush();
}

// The board's first load, settled, with the stream connected.
async function openSettledBoard() {
  await openBoard();
  calls[0].resolve(1);
  await flush();
  stream().open();
  await flush();
  calls[1].resolve(1);
  await flush();
  calls.length = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  calls = [];
});

afterEach(() => {
  stopObserving();
  disconnect();
  queryClient.clear();
  queryClient.unmount();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a nudge on an idle board fetches once", async () => {
  await openSettledBoard();
  stream().nudge();
  await flush();
  expect(calls).toHaveLength(1);
  calls[0].resolve(2);
  await flush();
  expect(calls).toHaveLength(1);
  expect(fetchStatus()).toBe("idle");
  expect(observer.getCurrentResult().data).toBe(2);
});

test("pings never fetch", async () => {
  await openSettledBoard();
  for (let i = 0; i < 5; i++) stream().ping();
  await flush();
  expect(calls).toHaveLength(0);
});

test("a burst of nudges lets the running request finish, then fetches once more", async () => {
  await openSettledBoard();
  stream().nudge();
  await flush();
  for (let i = 0; i < 4; i++) stream().nudge();
  await flush();
  expect(calls).toHaveLength(1);
  expect(calls[0].signal.aborted).toBe(false);

  calls[0].resolve(2);
  await flush();
  expect(observer.getCurrentResult().data).toBe(2);
  expect(calls).toHaveLength(2);

  calls[1].resolve(3);
  await flush();
  expect(calls).toHaveLength(2);
  expect(fetchStatus()).toBe("idle");
  expect(observer.getCurrentResult().data).toBe(3);
});

test("a stream reconnect mid-request doesn't cancel it", async () => {
  await openSettledBoard();
  stream().nudge();
  await flush();
  stream().drop();
  stream().open();
  await flush();
  expect(calls[0].signal.aborted).toBe(false);
  calls[0].resolve(2);
  await flush();
  expect(calls).toHaveLength(2);
});

test("a stalled request hits its deadline and retries, staying fetching throughout", async () => {
  await openBoard();
  await vi.advanceTimersByTimeAsync(ATTEMPT_DEADLINE_MS);
  expect(calls[0].signal.aborted).toBe(true);
  expect(fetchStatus()).toBe("fetching");

  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(ATTEMPT_DEADLINE_MS);
  expect(fetchStatus()).toBe("fetching");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(calls).toHaveLength(3);

  calls[2].resolve(7);
  await flush();
  expect(fetchStatus()).toBe("idle");
  expect(observer.getCurrentResult().data).toBe(7);
});

test("retry waits grow 1s, 2s, then 5s", async () => {
  await openBoard();
  const fail = async (i: number) => {
    calls[i].reject(new TypeError("Load failed"));
    await flush();
  };
  await fail(0);
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(2);
  await fail(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(calls).toHaveLength(3);
  await fail(2);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(4);
  await fail(3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls).toHaveLength(5);
});

test("a wake during a retry wait tries at once", async () => {
  await openBoard();
  calls[0].reject(new TypeError("Load failed"));
  await flush();
  stream().open();
  await flush();
  expect(calls).toHaveLength(2);
});

test("a wake during a failing attempt skips the next wait", async () => {
  await openBoard();
  stream().open();
  await flush();
  calls[0].reject(new TypeError("Load failed"));
  await flush();
  expect(calls).toHaveLength(2);
});

test("offline doesn't pause the board", async () => {
  onlineManager.setOnline(false);
  await openBoard();
  expect(calls).toHaveLength(1);
  expect(fetchStatus()).toBe("fetching");
});

test("a gateway error from a proxy retries until through", async () => {
  await openBoard();
  calls[0].reject(new ORPCError("BAD_GATEWAY", { status: 502 }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toHaveLength(2);
  expect(fetchStatus()).toBe("fetching");
});

test("our server's errors keep the normal retry handling", async () => {
  await openBoard();
  for (let i = 0; i < 3; i++) {
    calls[i].reject(new ORPCError("UNAUTHORIZED", { status: 401 }));
    await flush();
  }
  await flush();
  expect(calls).toHaveLength(3);
  expect(observer.getCurrentResult().status).toBe("error");
  expect(fetchStatus()).toBe("idle");
});

test("a hidden tab holds the retry until it's visible again", async () => {
  await openBoard();
  focusManager.setFocused(false);
  calls[0].reject(new TypeError("Load failed"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls).toHaveLength(1);
  focusManager.setFocused(true);
  await flush();
  expect(calls).toHaveLength(2);
});

test("leaving the board stops retries", async () => {
  await openBoard();
  calls[0].reject(new TypeError("Load failed"));
  await flush();
  stopObserving();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toHaveLength(1);
});

test("the poll speeds up only after the stream has been down for the grace period", async () => {
  await openSettledBoard();
  stream().drop();
  await vi.advanceTimersByTimeAsync(STREAM_DOWN_GRACE_MS - 1);
  expect(isStreamUp()).toBe(true);
  stream().open();
  await vi.advanceTimersByTimeAsync(STREAM_DOWN_GRACE_MS);
  expect(isStreamUp()).toBe(true);

  stream().drop();
  await vi.advanceTimersByTimeAsync(STREAM_DOWN_GRACE_MS);
  expect(isStreamUp()).toBe(false);
  stream().open();
  expect(isStreamUp()).toBe(true);
});

test("pings keep the stream; silence reopens it", async () => {
  await openSettledBoard();
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(25_000);
    stream().ping();
  }
  expect(FakeEventSource.instances).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(75_000);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(FakeEventSource.instances[0].closed).toBe(true);
});

test("a hidden tab never reopens the stream for silence", async () => {
  await openSettledBoard();
  focusManager.setFocused(false);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(FakeEventSource.instances).toHaveLength(1);
});
