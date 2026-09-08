let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
const tabId = Math.random().toString(36).slice(2);
const channelName = "openbib-session";

export class SessionChangedError extends Error {
  constructor() { super("Session changed"); }
}

export function sessionGeneration() { return generation; }
export function invalidateSession() { return ++generation; }
export function assertSession(expected: number) {
  if (generation !== expected) throw new SessionChangedError();
}

// All cookie mutations share one queue, also across tabs when Web Locks are available.
export function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = () => typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("openbib-session-cookie", operation) : operation();
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function announceSessionChange() {
  if (typeof window !== "undefined" && "BroadcastChannel" in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "changed", tabId });
    channel.close();
  }
}

export function listenForSessionChanges(onChange: () => void) {
  if (!("BroadcastChannel" in window)) return () => {};
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = ({ data }) => {
    if (data?.type === "changed" && data.tabId !== tabId) onChange();
  };
  return () => channel.close();
}

export function changeSession<T>(request: () => Promise<T>, commit: (result: T) => void | Promise<void>): Promise<T> {
  const expected = invalidateSession();
  return withSessionLock(async () => {
    assertSession(expected);
    const result = await request();
    // A newer explicit action wins, but only after this response has applied its cookie.
    assertSession(expected);
    announceSessionChange();
    await commit(result);
    return result;
  });
}
