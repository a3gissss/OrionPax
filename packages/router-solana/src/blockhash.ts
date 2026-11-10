// Keeps a fresh blockhash in memory so signing never waits on an RPC round-trip.

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Commitment,
  type GetLatestBlockhashApi,
  type Rpc,
} from "@solana/kit";

export interface CachedBlockhash {
  blockhash: string;
  /** Use as PreparedTx.validUntil. */
  lastValidBlockHeight: number;
  /** Slot the blockhash was observed at. */
  slot: number;
  fetchedAt: number;
}

export interface BlockhashCacheOptions {
  rpcUrl?: string;
  /** Pass an RPC instead of rpcUrl (e.g. for tests). */
  rpc?: Pick<Rpc<GetLatestBlockhashApi>, "getLatestBlockhash">;
  /** If set, refresh on every slot notification over WS; polling stays on as a fallback. */
  wsUrl?: string;
  /** Polling interval. Default 400 ms (about one slot). */
  intervalMs?: number;
  commitment?: Commitment;
  onError?: (err: unknown) => void;
}

export class BlockhashCache {
  private readonly rpc: Pick<Rpc<GetLatestBlockhashApi>, "getLatestBlockhash">;
  private readonly intervalMs: number;
  private readonly commitment: Commitment;
  private current: CachedBlockhash | undefined;
  private inflight: Promise<CachedBlockhash> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private abort: AbortController | undefined;
  private lastSlotNotificationAt = 0;
  private waiters: Array<{ resolve: (b: CachedBlockhash) => void; reject: (e: unknown) => void }> = [];

  constructor(private readonly opts: BlockhashCacheOptions) {
    if (!opts.rpc && !opts.rpcUrl) throw new Error("BlockhashCache needs rpc or rpcUrl");
    this.rpc = opts.rpc ?? createSolanaRpc(opts.rpcUrl!);
    this.intervalMs = opts.intervalMs ?? 400;
    this.commitment = opts.commitment ?? "confirmed";
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Begin prefetching. Resolves after the first blockhash arrives. */
  async start(): Promise<CachedBlockhash> {
    if (!this.timer) {
      this.abort = new AbortController();
      this.timer = setInterval(() => {
        // While slot notifications flow, they drive refreshes. Polling is only the fallback.
        if (Date.now() - this.lastSlotNotificationAt < this.intervalMs * 2) return;
        void this.refresh().catch(() => {});
      }, this.intervalMs);
      this.timer.unref?.();
      if (this.opts.wsUrl) void this.subscribeSlots(this.opts.wsUrl, this.abort.signal);
    }
    return this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
    for (const w of this.waiters.splice(0)) w.reject(new Error("BlockhashCache stopped"));
  }

  /** Latest cached value without waiting (undefined before the first fetch). */
  peek(): CachedBlockhash | undefined {
    return this.current;
  }

  /**
   * Freshest blockhash. Returns the cached value when it's newer than `maxAgeMs`
   * (default 2 × interval), otherwise fetches one.
   */
  async get(maxAgeMs = this.intervalMs * 2): Promise<CachedBlockhash> {
    if (this.current && Date.now() - this.current.fetchedAt <= maxAgeMs) return this.current;
    return this.refresh();
  }

  /** Resolves on the next successful refresh (useful right after a new slot). */
  next(): Promise<CachedBlockhash> {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Fetch now. Concurrent calls share one in-flight request. */
  refresh(): Promise<CachedBlockhash> {
    if (this.inflight) return this.inflight;
    // Start on a microtask so `inflight` is set before the finally can clear it (even on a sync throw).
    const p = Promise.resolve().then(async () => {
      try {
        const res = await this.rpc.getLatestBlockhash({ commitment: this.commitment }).send();
        const next: CachedBlockhash = {
          blockhash: res.value.blockhash,
          lastValidBlockHeight: Number(res.value.lastValidBlockHeight),
          slot: Number(res.context.slot),
          fetchedAt: Date.now(),
        };
        // Never move backwards if responses arrive out of order.
        if (!this.current || next.slot >= this.current.slot) this.current = next;
        const ws = this.waiters.splice(0);
        for (const w of ws) w.resolve(this.current);
        return this.current;
      } catch (err) {
        this.opts.onError?.(err);
        throw err;
      } finally {
        this.inflight = undefined;
      }
    });
    this.inflight = p;
    return p;
  }

  private async subscribeSlots(wsUrl: string, signal: AbortSignal): Promise<void> {
    try {
      const subs = createSolanaRpcSubscriptions(wsUrl);
      const stream = await subs.slotNotifications().subscribe({ abortSignal: signal });
      for await (const _ of stream) {
        this.lastSlotNotificationAt = Date.now();
        void this.refresh().catch(() => {});
      }
    } catch (err) {
      // Polling keeps the cache fresh when the WS is down.
      if (!signal.aborted) this.opts.onError?.(err);
    }
  }
}
