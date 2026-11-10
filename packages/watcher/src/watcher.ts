// Go-live detection: decides the exact moment a mint/launch opens and fires the engine.
// Chain-agnostic: every chain-specific capability (state reads, log/account subscriptions,
// chain clock, block/slot height) is injected as a dependency.

import type { ChainAdapter, EngineEvent, GoLiveTrigger, MintState, MintTarget } from "@mint-engine/core";
import { abortReason, jitteredBackoff, preciseNow, sleep, throwIfAborted, waitUntil } from "./timing.js";

export type Unsubscribe = () => void | Promise<void>;
type MaybePromise<T> = T | Promise<T>;

export interface WatcherDeps {
  /** Engine event sink (`mint.state`, `log`). */
  emit?: (event: EngineEvent) => void;
  /** Attached to emitted events. */
  jobId?: string;
  /** Required for `state-poll`; optional for `event` (initial/verification check). */
  adapter?: Pick<ChainAdapter, "detect">;
  target?: MintTarget;
  /**
   * Chain clock in Unix ms (e.g. latest EVM block timestamp * 1000, Solana getBlockTime * 1000).
   * Used by `time` triggers to correct local clock skew.
   */
  getChainTime?: () => Promise<number>;
  /**
   * Generic event subscription for `event` triggers (EVM log subscription, Solana
   * onAccountChange / logsSubscribe, ...). Call `cb` whenever a go-live signal arrives.
   */
  subscribe?: (cb: (payload?: unknown) => void, ctx: { signature?: string; signal: AbortSignal }) => MaybePromise<Unsubscribe>;
  /** Current block number / slot for `slot-or-block` triggers. */
  getHeight?: () => Promise<number>;
  /** Optional push-based height feed; preferred over polling `getHeight` when present. */
  subscribeHeight?: (cb: (height: number) => void) => MaybePromise<Unsubscribe>;
  /** Clock override (Unix ms). Defaults to a high-resolution wall clock. */
  now?: () => number;
  /** RNG override for backoff jitter (tests). */
  random?: () => number;
}

export interface ArmInfo {
  trigger: GoLiveTrigger;
  armedAt: number;
  /** Expected go-live time in local-clock Unix ms, when known. */
  expectedAt?: number;
  /** Expected go-live height, for `slot-or-block`. */
  expectedHeight?: number;
}

export interface GoLiveResult {
  trigger: GoLiveTrigger["type"];
  /** Local-clock Unix ms at which go-live was detected. */
  firedAt: number;
  /** When `onArm` was invoked (if it was). */
  armedAt?: number;
  /** For `time`: scheduled go-live converted to local clock (ms). */
  scheduledAt?: number;
  /** For `time`: firedAt - scheduledAt. */
  latenessMs?: number;
  /** For `time`: estimated chainTime - localTime (ms). */
  clockOffsetMs?: number;
  /** Last mint state read (state-poll / event verification). */
  state?: MintState;
  /** Height observed at fire (slot-or-block). */
  height?: number;
  /** Payload passed to the event subscription callback. */
  event?: unknown;
}

export interface WatchOptions {
  signal?: AbortSignal;
  /** Fire `onArm` this many ms before the expected go-live (time triggers). Default 2000. */
  leadMs?: number;
  /** For slot-or-block: fire `onArm` when height >= at - leadBlocks. Default: arm immediately. */
  leadBlocks?: number;
  /** Pre-arm hook: prepare and sign txs. Triggers without a known t0 arm immediately. */
  onArm?: (info: ArmInfo) => void | Promise<void>;
  /** Fired at go-live, after onArm has settled (unless awaitArm=false). */
  onFire?: (result: GoLiveResult) => void | Promise<void>;
  /** Wait for a pending onArm before calling onFire. Default true. */
  awaitArm?: boolean;
  /** Final busy-wait window for time triggers. Default 50 ms. */
  spinMs?: number;
  /** Re-measure chain clock this many ms before go-live (time trigger). Default 3000. 0 disables. */
  resyncBeforeMs?: number;
  /** Max backoff on RPC errors. Default 5000 ms. */
  maxBackoffMs?: number;
  /** Poll interval for getHeight when no subscribeHeight. Default 250 ms. */
  heightPollMs?: number;
  /** For event triggers: confirm with adapter.detect() that the mint is live before firing. Default false. */
  verifyEvent?: boolean;
  /** After an event, keep re-checking detect() for this long (lagging RPCs). Default 10000 ms. */
  verifyWindowMs?: number;
  /**
   * Added to every getChainTime() sample. getChainTime should return the best estimate of the
   * chain's *current* time; when it is derived from the latest block timestamp (whole seconds,
   * already up to one block old) pass roughly blockTime/2 + 500 here, or the trigger fires late.
   */
  chainTimeBiasMs?: number;
  /**
   * With subscribeHeight + getHeight: safety poll interval in case the push feed silently stalls.
   * Default 1000 ms. 0 disables.
   */
  heightFallbackPollMs?: number;
}

const DEFAULT_LEAD_MS = 2000;
const DEFAULT_SPIN_MS = 50;
const DEFAULT_RESYNC_MS = 3000;
const DEFAULT_MAX_BACKOFF_MS = 5000;
const DEFAULT_HEIGHT_POLL_MS = 250;

interface Ctx {
  deps: WatcherDeps;
  opts: WatchOptions;
  now: () => number;
  signal: AbortSignal;
  log: (level: "info" | "warn" | "error", message: string) => void;
  emitState: (state: MintState) => void;
  arm: (info: Omit<ArmInfo, "trigger" | "armedAt">) => void;
}

/**
 * Resolve when `trigger` goes live. Calls `onArm` before go-live (t0 - leadMs for time triggers,
 * immediately for triggers without a known t0) and `onFire` at go-live.
 * Rejects with the signal's reason when aborted.
 */
export async function waitForGoLive(trigger: GoLiveTrigger, deps: WatcherDeps = {}, opts: WatchOptions = {}): Promise<GoLiveResult> {
  throwIfAborted(opts.signal);
  // Internal controller: aborted on completion so background loops (arm timers, polls) stop.
  const inner = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, inner.signal]) : inner.signal;
  const now = deps.now ?? preciseNow;

  const emit = (e: EngineEvent) => {
    try { deps.emit?.(e); } catch { /* a broken sink must not break the watcher */ }
  };
  const log: Ctx["log"] = (level, message) =>
    emit({ type: "log", jobId: deps.jobId, level, message: `[watcher] ${message}`, at: Date.now() });
  let lastStateKey: string | undefined;
  const emitState = (state: MintState) => {
    const key = JSON.stringify(state);
    if (key === lastStateKey || deps.jobId === undefined) { lastStateKey = key; return; }
    lastStateKey = key;
    emit({ type: "mint.state", jobId: deps.jobId, state, at: Date.now() });
  };

  let armedAt: number | undefined;
  let armPromise: Promise<void> | undefined;
  const arm: Ctx["arm"] = (info) => {
    if (armPromise || !opts.onArm) return;
    armedAt = now();
    log("info", `armed (${trigger.type})`);
    const onArm = opts.onArm;
    armPromise = Promise.resolve().then(() => onArm({ trigger, armedAt: armedAt!, ...info }));
    armPromise.catch((err) => {
      log("error", `onArm failed: ${errMsg(err)}`);
      // Fail fast: don't keep watching for hours only to throw at go-live.
      if (opts.awaitArm !== false) inner.abort(err);
    });
  };

  const ctx: Ctx = { deps, opts, now, signal, log, emitState, arm };

  try {
    let result: GoLiveResult;
    switch (trigger.type) {
      case "now": arm({ expectedAt: now() }); result = { trigger: "now", firedAt: now() }; break;
      case "time": result = await waitTime(trigger, ctx); break;
      case "state-poll": result = await waitStatePoll(trigger, ctx); break;
      case "event": result = await waitEvent(trigger, ctx); break;
      case "slot-or-block": result = await waitHeight(trigger, ctx); break;
      default: {
        const t: never = trigger;
        throw new Error(`unsupported trigger: ${JSON.stringify(t)}`);
      }
    }
    // Late arm: go-live happened before the arm point (e.g. already live).
    arm({});
    if (armedAt !== undefined) result.armedAt = armedAt;
    if (armPromise && opts.awaitArm !== false) await armPromise;
    throwIfAborted(opts.signal);
    log("info", `go-live (${trigger.type})${result.latenessMs !== undefined ? ` lateness=${result.latenessMs.toFixed(2)}ms` : ""}`);
    await opts.onFire?.(result);
    return result;
  } finally {
    inner.abort();
  }
}

// ---------- time ----------

async function measureOffset(ctx: Ctx): Promise<number | undefined> {
  const getChainTime = ctx.deps.getChainTime;
  if (!getChainTime) return undefined;
  try {
    const t0 = ctx.now();
    const chain = await getChainTime();
    const t1 = ctx.now();
    throwIfAborted(ctx.signal);
    if (!Number.isFinite(chain)) throw new Error(`invalid chain time ${chain}`);
    return chain + (ctx.opts.chainTimeBiasMs ?? 0) - (t0 + t1) / 2;
  } catch (err) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    ctx.log("warn", `getChainTime failed, keeping previous clock offset: ${errMsg(err)}`);
    return undefined;
  }
}

async function waitTime(trigger: { type: "time"; at: number }, ctx: Ctx): Promise<GoLiveResult> {
  const { opts, now, signal } = ctx;
  const leadMs = opts.leadMs ?? DEFAULT_LEAD_MS;
  const spinMs = opts.spinMs ?? DEFAULT_SPIN_MS;
  const resyncBefore = opts.resyncBeforeMs ?? DEFAULT_RESYNC_MS;

  let offset = (await measureOffset(ctx)) ?? 0;
  if (offset !== 0) ctx.log("info", `clock offset chain-local = ${offset.toFixed(1)}ms`);
  const localTarget = () => trigger.at - offset;

  // Arm in the background at t0 - leadMs (re-reading the target so resyncs are honoured).
  if (opts.onArm) {
    void waitUntil(() => localTarget() - leadMs, { now, spinMs: 0, maxChunkMs: 250, signal })
      .then(() => ctx.arm({ expectedAt: localTarget() }), () => {});
  }

  if (ctx.deps.getChainTime && resyncBefore > 0 && localTarget() - now() > resyncBefore) {
    await waitUntil(() => localTarget() - resyncBefore, { now, spinMs: 0, signal });
    const o = await measureOffset(ctx);
    if (o !== undefined) offset = o;
  }

  await waitUntil(localTarget, { now, spinMs, signal });
  const firedAt = now();
  const scheduledAt = localTarget();
  return { trigger: "time", firedAt, scheduledAt, latenessMs: firedAt - scheduledAt, clockOffsetMs: offset };
}

// ---------- state-poll ----------

async function waitStatePoll(trigger: { type: "state-poll"; intervalMs: number }, ctx: Ctx): Promise<GoLiveResult> {
  const { deps, opts, signal } = ctx;
  const { adapter, target } = deps;
  if (!adapter || !target) throw new Error("state-poll trigger requires deps.adapter and deps.target");
  const interval = Math.max(1, trigger.intervalMs);
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  ctx.arm({});
  let errors = 0;
  for (;;) {
    throwIfAborted(signal);
    let state: MintState;
    try {
      state = await adapter.detect(target);
    } catch (err) {
      throwIfAborted(signal);
      errors++;
      const delay = jitteredBackoff(interval, errors, Math.max(interval, maxBackoff), deps.random);
      ctx.log("warn", `detect failed (attempt ${errors}), retrying in ${delay}ms: ${errMsg(err)}`);
      await sleep(delay, signal);
      continue;
    }
    throwIfAborted(signal);
    errors = 0;
    ctx.emitState(state);
    if (state.live) return { trigger: "state-poll", firedAt: ctx.now(), state };
    await sleep(interval, signal);
  }
}

// ---------- subscriptions ----------

/**
 * Run a push subscription until `done` or `fail` is called or the signal aborts.
 * The unsubscribe handle is always released, even when `subscribe` resolves after the watch ended.
 */
function subscribeUntil<T>(
  ctx: Ctx,
  subscribe: (done: (v: T) => void) => MaybePromise<Unsubscribe>,
  afterSubscribed?: (done: (v: T) => void, isSettled: () => boolean) => void | Promise<void>,
): Promise<T> {
  const { signal } = ctx;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    let settled = false;
    const isSettled = () => settled;
    const subP = Promise.resolve().then(() => subscribe(done));
    const release = () => {
      subP.then(
        (u) => Promise.resolve()
          .then(() => u?.())
          .catch((err) => ctx.log("warn", `unsubscribe failed: ${errMsg(err)}`)),
        () => {},
      );
    };
    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      release(); // queued before the caller's continuation, so cleanup happens first
      settle();
    }
    function done(v: T) { finish(() => resolve(v)); }
    function fail(e: unknown) { finish(() => reject(e)); }
    function onAbort() { fail(abortReason(signal)); }
    signal.addEventListener("abort", onAbort, { once: true });
    subP
      .then(async () => { if (!settled) await afterSubscribed?.(done, isSettled); })
      .catch(fail);
  });
}

// ---------- event ----------

async function waitEvent(trigger: { type: "event"; signature?: string }, ctx: Ctx): Promise<GoLiveResult> {
  const { deps, opts, signal } = ctx;
  const subscribe = deps.subscribe;
  if (!subscribe) throw new Error("event trigger requires deps.subscribe");
  const canDetect = !!(deps.adapter && deps.target);
  if (opts.verifyEvent && !canDetect) throw new Error("verifyEvent requires deps.adapter and deps.target");
  const verifyWindow = opts.verifyWindowMs ?? 10_000;
  ctx.arm({});

  const detect = async (): Promise<MintState | undefined> => {
    try {
      const s = await deps.adapter!.detect(deps.target!);
      ctx.emitState(s);
      return s;
    } catch (err) {
      if (!signal.aborted) ctx.log("warn", `detect failed during event watch: ${errMsg(err)}`);
      return undefined;
    }
  };

  let verifying = false;
  return subscribeUntil<GoLiveResult>(
    ctx,
    (done) => {
      const onEvent = (payload?: unknown) => {
        const firedAt = ctx.now();
        if (!opts.verifyEvent) return done({ trigger: "event", firedAt, event: payload });
        if (verifying) return;
        verifying = true;
        // Re-check for a while: a lagging RPC may not reflect the event's state change yet.
        void (async () => {
          const until = ctx.now() + verifyWindow;
          for (let attempt = 1; !signal.aborted; attempt++) {
            const s = await detect();
            if (s?.live) return done({ trigger: "event", firedAt, event: payload, state: s });
            if (ctx.now() >= until) break;
            await sleep(Math.min(100 * attempt, 500), signal).catch(() => {});
          }
          verifying = false;
          if (!signal.aborted) ctx.log("info", "event received but mint not live; still watching");
        })();
      };
      return subscribe(onEvent, { signature: trigger.signature, signal });
    },
    async (done) => {
      // Closes the race where go-live happened before the subscription was established.
      if (!canDetect) return;
      const s = await detect();
      if (s?.live) done({ trigger: "event", firedAt: ctx.now(), state: s });
    },
  );
}

// ---------- slot-or-block ----------

async function waitHeight(trigger: { type: "slot-or-block"; at: number }, ctx: Ctx): Promise<GoLiveResult> {
  const { deps, opts, signal } = ctx;
  if (!deps.getHeight && !deps.subscribeHeight) throw new Error("slot-or-block trigger requires deps.getHeight or deps.subscribeHeight");
  const armHeight = opts.leadBlocks !== undefined ? trigger.at - opts.leadBlocks : -Infinity;
  const onHeight = (h: number) => {
    if (h >= armHeight) ctx.arm({ expectedHeight: trigger.at });
  };
  if (armHeight === -Infinity) ctx.arm({ expectedHeight: trigger.at });
  const poll = Math.max(1, opts.heightPollMs ?? DEFAULT_HEIGHT_POLL_MS);
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  if (deps.subscribeHeight) {
    const subscribeHeight = deps.subscribeHeight;
    const getHeight = deps.getHeight;
    const fallback = opts.heightFallbackPollMs ?? 1000;
    let see: (h: number) => void = () => {};
    return subscribeUntil<GoLiveResult>(
      ctx,
      (done) => {
        see = (h: number) => {
          if (!Number.isFinite(h)) return;
          onHeight(h);
          if (h >= trigger.at) done({ trigger: "slot-or-block", firedAt: ctx.now(), height: h });
        };
        return subscribeHeight((h) => see(h));
      },
      async (_done, isSettled) => {
        if (!getHeight) return;
        // Initial read, then a slow safety poll in case the push feed stalls silently.
        for (let first = true; !isSettled() && !signal.aborted; first = false) {
          if (!first) {
            if (fallback <= 0) return;
            await sleep(fallback, signal).catch(() => {});
            if (isSettled() || signal.aborted) return;
          }
          try {
            see(await getHeight());
          } catch (err) {
            if (!signal.aborted) ctx.log("warn", `getHeight failed: ${errMsg(err)}`);
          }
        }
      },
    );
  }

  const getHeight = deps.getHeight!;
  let errors = 0;
  for (;;) {
    throwIfAborted(signal);
    let h: number;
    try {
      h = await getHeight();
    } catch (err) {
      throwIfAborted(signal);
      errors++;
      const delay = jitteredBackoff(poll, errors, Math.max(poll, maxBackoff), deps.random);
      ctx.log("warn", `getHeight failed (attempt ${errors}), retrying in ${delay}ms: ${errMsg(err)}`);
      await sleep(delay, signal);
      continue;
    }
    throwIfAborted(signal);
    errors = 0;
    onHeight(h);
    if (h >= trigger.at) return { trigger: "slot-or-block", firedAt: ctx.now(), height: h };
    await sleep(poll, signal);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- Watcher ----------

export interface WatchHandle {
  readonly id: number;
  readonly trigger: GoLiveTrigger;
  readonly result: Promise<GoLiveResult>;
  cancel(reason?: unknown): void;
}

/**
 * Owns a set of concurrent go-live watches sharing the same base dependencies.
 * Per-watch deps (adapter/target/subscribe/jobId) can be overridden in `watch()`.
 */
export class Watcher {
  private nextId = 1;
  private readonly watches = new Map<number, { handle: WatchHandle; ctrl: AbortController }>();

  constructor(private readonly deps: WatcherDeps = {}) {}

  watch(trigger: GoLiveTrigger, opts: WatchOptions = {}, depsOverride: Partial<WatcherDeps> = {}): WatchHandle {
    const id = this.nextId++;
    const ctrl = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
    const result = waitForGoLive(trigger, { ...this.deps, ...depsOverride }, { ...opts, signal })
      .finally(() => this.watches.delete(id));
    const handle: WatchHandle = {
      id,
      trigger,
      result,
      cancel: (reason?: unknown) => ctrl.abort(reason ?? new DOMException("Watch cancelled", "AbortError")),
    };
    this.watches.set(id, { handle, ctrl });
    return handle;
  }

  /** Convenience: watch and await. */
  waitForGoLive(trigger: GoLiveTrigger, opts: WatchOptions = {}, depsOverride: Partial<WatcherDeps> = {}): Promise<GoLiveResult> {
    return this.watch(trigger, opts, depsOverride).result;
  }

  get active(): number {
    return this.watches.size;
  }

  cancelAll(reason?: unknown): void {
    for (const { handle } of [...this.watches.values()]) handle.cancel(reason);
  }
}

/**
 * Standalone pre-arm helper: run `onArm` at `t0 - leadMs` and `onFire` at `t0` (local clock).
 * Equivalent to `waitForGoLive({ type: "time", at: t0 }, deps, { onArm, onFire, leadMs })`.
 */
export function prearm(
  t0: number,
  hooks: { onArm: (info: ArmInfo) => void | Promise<void>; onFire: (result: GoLiveResult) => void | Promise<void> },
  opts: Omit<WatchOptions, "onArm" | "onFire"> = {},
  deps: WatcherDeps = {},
): Promise<GoLiveResult> {
  return waitForGoLive({ type: "time", at: t0 }, deps, { ...opts, onArm: hooks.onArm, onFire: hooks.onFire });
}
