// Low-level, cancellable timing primitives used by the watcher.

let anchor = Date.now() - performance.now();
let last = -Infinity;
/** Re-anchor only on real drift; Date.now() itself is quantised to whole ms. */
const REANCHOR_MS = 5;

/**
 * Wall clock in Unix ms with sub-ms resolution: performance.now() anchored to Date.now(),
 * re-anchored when they drift apart by more than a few ms (NTP adjustments, long uptimes).
 * Never steps backwards.
 */
export function preciseNow(): number {
  const p = performance.now();
  const d = Date.now();
  let t = anchor + p;
  if (Math.abs(t - d) > REANCHOR_MS) {
    anchor = d - p;
    t = d;
  }
  if (t < last) t = last;
  last = t;
  return t;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Max delay accepted by setTimeout (~24.8 days). */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** setTimeout as a promise that rejects when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Math.min(ms, MAX_TIMEOUT)));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Yield to the event loop once (cheap; lets I/O and timers run). */
export function yieldImmediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface WaitUntilOptions {
  now: () => number;
  /** Final window (ms) handled by a setImmediate spin instead of setTimeout. 0 disables spinning. */
  spinMs: number;
  /** Cap on a single coarse sleep so a moving target (clock resync) is re-read regularly. */
  maxChunkMs?: number;
  signal?: AbortSignal;
}

/**
 * Wait until `now() >= getTarget()`. The target is re-evaluated on every iteration so it can be
 * moved (e.g. after a clock-skew resync). Coarse setTimeout sleeps are used until the last
 * `spinMs`, then the loop spins on setImmediate for sub-millisecond precision.
 */
export async function waitUntil(getTarget: () => number, opts: WaitUntilOptions): Promise<void> {
  const { now, spinMs, signal } = opts;
  const maxChunk = opts.maxChunkMs ?? MAX_TIMEOUT;
  for (;;) {
    throwIfAborted(signal);
    const remaining = getTarget() - now();
    if (remaining <= 0) return;
    if (remaining > spinMs) {
      await sleep(Math.min(remaining - spinMs, maxChunk), signal);
    } else {
      await yieldImmediate();
    }
  }
}

/** Exponential backoff with +/-50% jitter, never above `maxMs`. `attempt` starts at 1. */
export function jitteredBackoff(baseMs: number, attempt: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt - 1, 30)));
  return Math.max(1, Math.min(maxMs, Math.round(exp * (0.5 + random()))));
}
