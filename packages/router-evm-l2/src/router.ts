// TxRouter for the L2s: Base (OP Stack) and Robinhood Chain (Arbitrum Orbit / Nitro).
//
// Both have a single sequencer and no public mempool, so there's nothing to bid
// against in a mempool. What wins is reaching the sequencer early:
// - Base: since the Denim upgrade (mainnet 5 Nov 2026) every block is a canonical 200 ms
//   block ordered by priority fee; Flashblocks and their preconfirmations are retired.
//   A receipt in a canonical block is the confirmation. The old Flashblocks preconf path
//   is kept behind `legacyFlashblocks` (off by default) for pre-Denim test networks.
// - Robinhood (Nitro) is first-come-first-serve; fees don't reorder. Its docs don't
//   mention Timeboost (a paid express lane); see timeboost.ts.
//
// So `send` fires every signed tx to every endpoint at once over pre-warmed keep-alive
// connections, and records per-tx send latency.

import type { ChainConfig, ChainId, FeeStrategy, PreparedTx, SentTx, TxOutcome, TxRouter, TxStatus } from "@mint-engine/core";
import { keccak256, toHex } from "viem";
import { l2FeeStrategy, type L2Chain, type L2Fees } from "./fees.js";
import { BatchUnsupportedError, KeepAliveTransport, RpcError, type KeepAliveOptions, type RpcCall, type RpcClient, type RpcResult } from "./keepalive.js";
import { submitExpressLane, type ExpressLaneConfig } from "./timeboost.js";

export const L2_CHAINS: readonly L2Chain[] = ["base", "robinhood"];

export interface EndpointAttempt {
  /** Redacted endpoint label (host only). */
  endpoint: string;
  ok: boolean;
  /** ms from dispatch until this endpoint answered. */
  ms: number;
  error?: string;
  /** The node definitively rejected the tx (JSON-RPC error), as opposed to a timeout/network failure. */
  rejected?: boolean;
}

/** Cap on retained SendStats (oldest are dropped). */
export const MAX_SEND_STATS = 10_000;

export interface SendStat {
  chain: L2Chain;
  walletId: string;
  hash: `0x${string}`;
  sentAt: number;
  /** ms from dispatch to the first accepting endpoint; undefined if none accepted. */
  latencyMs?: number;
  attempts: EndpointAttempt[];
}

export interface L2RouterOptions {
  /** Confirmation poll interval. Default 50 ms (a quarter of a Base block). */
  pollIntervalMs?: number;
  /**
   * Base only: enable the pre-Denim Flashblocks preconfirmation path ("preconfirmed" status
   * from Flashblocks receipts / the `pending` block). Off by default: Base mainnet retired
   * Flashblocks on 5 Nov 2026, and `pending` now just resolves to the latest canonical block.
   */
  legacyFlashblocks?: boolean;
  /** Base + legacyFlashblocks only: a Flashblocks-aware RPC, if separate from the primary. */
  flashblocksRpcUrl?: string;
  /** Robinhood only: Timeboost express lane. STUB, UNVERIFIED, off unless `enabled`. */
  expressLane?: ExpressLaneConfig;
  /** Overrides for every KeepAliveTransport this router creates. */
  transport?: Omit<KeepAliveOptions, "url" | "wsUrl">;
  /** Called once per tx after `send` gets every endpoint's answer. */
  onSendStat?: (stat: SendStat) => void;
  /** Called on every status change seen by `confirm`. */
  onStatus?: (outcome: TxOutcome) => void;
}

export interface ConfirmOptions {
  timeoutMs?: number;
  /** Treat "preconfirmed" (Base Flashblock inclusion) as terminal. */
  acceptPreconf?: boolean;
  /** Per-call status-change callback (in addition to L2RouterOptions.onStatus). */
  onUpdate?: (outcome: TxOutcome) => void;
}

interface Lane {
  chain: L2Chain;
  primary: KeepAliveTransport;
  extras: KeepAliveTransport[];
  /** Base: Flashblocks-aware RPC, if separate from primary. */
  flashblocks?: KeepAliveTransport;
  /** Robinhood: express-lane endpoint (when enabled). */
  express?: KeepAliveTransport;
}

interface Receipt {
  status?: string;
  blockNumber?: string | null;
  transactionHash?: string;
}

export class L2Router implements TxRouter {
  readonly chains: ChainId[];
  /** Every send stat recorded by this router, in dispatch order. */
  readonly sendStats: SendStat[] = [];
  private readonly lanes = new Map<ChainId, Lane>();
  private readonly sendFailures = new Map<string, string>();
  /** Background endpoint answers still arriving after `send` resolved. */
  private readonly inflight = new Set<Promise<void>>();
  private readonly pollIntervalMs: number;

  constructor(configs: ChainConfig[], private readonly opts: L2RouterOptions = {}) {
    if (configs.length === 0) throw new Error("L2Router needs at least one ChainConfig");
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
    for (const cfg of configs) {
      if (!isL2(cfg.chain)) throw new Error(`L2Router does not handle chain "${cfg.chain}"`);
      if (this.lanes.has(cfg.chain)) throw new Error(`duplicate ChainConfig for "${cfg.chain}"`);
      const mk = (url: string, wsUrl?: string) => new KeepAliveTransport({ ...opts.transport, url, wsUrl });
      const lane: Lane = {
        chain: cfg.chain,
        primary: mk(cfg.rpcUrl, cfg.wsUrl),
        extras: (cfg.extraRpcUrls ?? []).filter((u) => u !== cfg.rpcUrl).map((u) => mk(u)),
      };
      if (cfg.chain === "base" && opts.legacyFlashblocks && opts.flashblocksRpcUrl && opts.flashblocksRpcUrl !== cfg.rpcUrl) {
        lane.flashblocks = mk(opts.flashblocksRpcUrl);
      }
      if (cfg.chain === "robinhood" && opts.expressLane?.enabled) {
        lane.express = opts.expressLane.rpcUrl ? mk(opts.expressLane.rpcUrl) : lane.primary;
      }
      this.lanes.set(cfg.chain, lane);
    }
    this.chains = [...this.lanes.keys()];
  }

  /** Pre-open connections on every endpoint. Call before the mint goes live. */
  async warm(): Promise<void> {
    await Promise.all([...this.lanes.values()].flatMap((l) => this.transportsOf(l).map((t) => t.warm())));
  }

  /** Wait until every endpoint has answered every send (stats complete). */
  async settled(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  async close(): Promise<void> {
    await this.settled();
    await Promise.all([...this.lanes.values()].flatMap((l) => this.transportsOf(l).map((t) => t.close())));
  }

  /** Most recent stat per tx hash. */
  sendStatFor(hash: string): SendStat | undefined {
    for (let i = this.sendStats.length - 1; i >= 0; i--) if (this.sendStats[i]!.hash === hash) return this.sendStats[i];
    return undefined;
  }

  /** Read the latest base fee and apply `l2FeeStrategy` for `chain`. */
  async suggestFees(chain: L2Chain, fees: FeeStrategy, gas?: bigint): Promise<L2Fees> {
    const block = await this.lane(chain).primary.request<{ baseFeePerGas?: string } | null>("eth_getBlockByNumber", ["latest", false]);
    const baseFeePerGas = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
    return l2FeeStrategy(chain, fees, { baseFeePerGas, gas });
  }

  /**
   * Fire every signed tx at every endpoint at once. All requests are dispatched
   * synchronously before the first await, so no tx waits on another.
   */
  async send(signed: Array<{ prepared: PreparedTx; signed: Uint8Array }>, _fees: FeeStrategy): Promise<SentTx[]> {
    // Validate everything before firing anything.
    const lanes = signed.map(({ prepared }) => this.lane(prepared.chain));
    return Promise.all(signed.map(({ prepared, signed: raw }, i) => this.dispatch(lanes[i]!, prepared, raw)));
  }

  async confirm(sent: SentTx[], opts: ConfirmOptions = {}): Promise<TxOutcome[]> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    const acceptPreconf = opts.acceptPreconf ?? false;
    const outcomes: TxOutcome[] = sent.map((s) => ({ sent: s, status: "sent" as TxStatus }));

    const emit = (o: TxOutcome) => {
      const copy = { ...o };
      this.opts.onStatus?.(copy);
      opts.onUpdate?.(copy);
    };
    const update = (i: number, status: TxStatus, block?: number, error?: string) => {
      const prev = outcomes[i]!;
      if (prev.status === status) return;
      const next: TxOutcome = { sent: prev.sent, status, slotOrBlock: block ?? prev.slotOrBlock };
      if (error) next.error = error;
      if (status === "confirmed" || status === "preconfirmed" || status === "failed") next.confirmedAt = Date.now();
      outcomes[i] = next;
      emit(next);
    };
    const isDone = (s: TxStatus) => s === "confirmed" || s === "failed" || s === "expired" || (acceptPreconf && s === "preconfirmed");

    // Txs every endpoint definitively rejected fail immediately. Ambiguous sends
    // (timeouts, dropped connections) are polled like any other: they may have landed.
    sent.forEach((s, i) => {
      const failure = s.via.length === 0 ? this.sendFailures.get(s.id) : undefined;
      if (failure) update(i, "failed", undefined, failure);
    });

    for (;;) {
      const pending = outcomes.map((o, i) => ({ o, i })).filter(({ o }) => !isDone(o.status));
      if (pending.length === 0) break;
      if (Date.now() >= deadline) {
        for (const { o, i } of pending) outcomes[i] = { ...o, error: `timeout after ${timeoutMs} ms` };
        break;
      }
      const byChain = new Map<ChainId, Array<{ o: TxOutcome; i: number }>>();
      for (const p of pending) {
        const list = byChain.get(p.o.sent.chain) ?? [];
        list.push(p);
        byChain.set(p.o.sent.chain, list);
      }
      await Promise.all([...byChain].map(async ([chain, items]) => {
        const lane = this.lanes.get(chain);
        if (!lane) {
          for (const { i } of items) update(i, "failed", undefined, `chain "${chain}" not handled by this router`);
          return;
        }
        try {
          await this.pollLane(lane, items, update);
        } catch {
          // Transient RPC error: try again next tick.
        }
      }));
      const left = deadline - Date.now();
      if (outcomes.some((o) => !isDone(o.status)) && left > 0) await sleep(Math.min(this.pollIntervalMs, left));
    }
    for (const o of outcomes) if (o.status === "confirmed" || o.status === "failed") this.sendFailures.delete(o.sent.id);
    return outcomes;
  }

  // ---------- internals ----------

  private lane(chain: ChainId): Lane {
    const lane = this.lanes.get(chain);
    if (!lane) throw new Error(`L2Router has no config for chain "${chain}"`);
    return lane;
  }

  private transportsOf(l: Lane): KeepAliveTransport[] {
    const set = new Set<KeepAliveTransport>([l.primary, ...l.extras]);
    if (l.flashblocks) set.add(l.flashblocks);
    if (l.express) set.add(l.express);
    return [...set];
  }

  /**
   * Fire one tx at every endpoint. Resolves on the FIRST accepting endpoint (so a
   * slow or dead extra RPC never delays the caller); the remaining answers are
   * still appended to the tx's SendStat as they arrive, and `onSendStat` fires once
   * all endpoints have answered.
   */
  private dispatch(lane: Lane, prepared: PreparedTx, raw: Uint8Array): Promise<SentTx> {
    const hex = toHex(raw);
    const hash = keccak256(raw);
    const sentAt = Date.now();
    const t0 = performance.now();
    const stat: SendStat = { chain: lane.chain, walletId: prepared.walletId, hash, sentAt, attempts: [] };
    this.recordStat(stat);

    const attempts: Array<Promise<EndpointAttempt>> = [lane.primary, ...lane.extras].map((ep) =>
      ep.request<string>("eth_sendRawTransaction", [hex]).then(
        (): EndpointAttempt => ({ endpoint: ep.label, ok: true, ms: performance.now() - t0 }),
        (e: unknown): EndpointAttempt => {
          const error = errMsg(e);
          const ok = isAlreadyKnown(error);
          return { endpoint: ep.label, ok, ms: performance.now() - t0, error, rejected: !ok && isNodeRejection(e) };
        },
      ),
    );
    if (lane.express && this.opts.expressLane?.enabled) {
      const express = lane.express;
      const cfg = this.opts.expressLane;
      const endpoint = `express-lane:${express.label}`;
      attempts.push(
        submitExpressLane(express, cfg, hex).then(
          (ok): EndpointAttempt => (ok ? { endpoint, ok, ms: performance.now() - t0 } : { endpoint, ok, ms: performance.now() - t0, error: "skipped", rejected: true }),
          (e: unknown): EndpointAttempt => ({ endpoint, ok: false, ms: performance.now() - t0, error: errMsg(e), rejected: isNodeRejection(e) }),
        ),
      );
    }

    return new Promise<SentTx>((resolve) => {
      let resolved = false;
      const finish = () => {
        resolved = true;
        resolve({ chain: lane.chain, walletId: prepared.walletId, id: hash, sentAt, via: stat.attempts.filter((a) => a.ok).map((a) => a.endpoint) });
      };
      for (const p of attempts) {
        void p.then((a) => {
          stat.attempts.push(a);
          if (a.ok && stat.latencyMs === undefined) stat.latencyMs = a.ms;
          if (a.ok && !resolved) finish();
        });
      }
      const settled = Promise.all(attempts).then(() => {
        const accepted = stat.attempts.some((a) => a.ok);
        // Only a definitive rejection by every endpoint means the tx is dead. A
        // timeout or dropped connection is ambiguous: the sequencer may have it.
        if (!accepted && stat.attempts.every((a) => a.rejected)) {
          this.sendFailures.set(hash, stat.attempts.map((a) => `${a.endpoint}: ${a.error}`).join("; "));
        }
        if (!resolved) finish();
        this.opts.onSendStat?.(stat);
      });
      this.inflight.add(settled);
      void settled.finally(() => this.inflight.delete(settled));
    });
  }

  private recordStat(stat: SendStat): void {
    this.sendStats.push(stat);
    if (this.sendStats.length > MAX_SEND_STATS) this.sendStats.splice(0, this.sendStats.length - MAX_SEND_STATS);
  }

  private async pollLane(
    lane: Lane,
    items: Array<{ o: TxOutcome; i: number }>,
    update: (i: number, status: TxStatus, block?: number, error?: string) => void,
  ): Promise<void> {
    const hashes = items.map(({ o }) => o.sent.id);
    const receiptCalls: RpcCall[] = hashes.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] }));
    // Preconfirmation tracking only applies to Base with the legacy Flashblocks path on.
    const isBase = lane.chain === "base" && this.opts.legacyFlashblocks === true;
    // Txs still waiting for a first sighting are worth checking on the Flashblocks RPC.
    const fbItems = isBase && lane.flashblocks ? items.filter(({ o }) => o.status === "sent") : [];

    const [canon, fb] = await Promise.all([
      multi(lane.primary, [{ method: "eth_blockNumber" }, ...receiptCalls]),
      fbItems.length
        ? multi(lane.flashblocks!, [
            { method: "eth_getBlockByNumber", params: ["pending", false] },
            ...fbItems.map(({ o }) => ({ method: "eth_getTransactionReceipt", params: [o.sent.id] })),
          ])
        : Promise.resolve([] as RpcResult[]),
    ]);

    const head = canon[0];
    if (!head?.ok) throw head?.error ?? new Error("eth_blockNumber failed");
    const latest = Number(BigInt(head.result as string));

    const fbReceipts = new Map<string, Receipt>();
    let pendingTxs = new Set<string>();
    let pendingNumber: number | undefined;
    if (fb.length) {
      const pb = fb[0];
      if (pb?.ok && pb.result) {
        const block = pb.result as { number?: string | null; transactions?: unknown[] };
        pendingNumber = block.number ? Number(BigInt(block.number)) : undefined;
        pendingTxs = new Set((block.transactions ?? []).map((t) => (typeof t === "string" ? t : (t as { hash?: string }).hash ?? "").toLowerCase()));
      }
      fbItems.forEach(({ o }, k) => {
        const r = fb[k + 1];
        if (r?.ok && r.result) fbReceipts.set(o.sent.id, r.result as Receipt);
      });
    }

    items.forEach(({ o, i }, k) => {
      const r = canon[k + 1];
      const receipt = r?.ok ? (r.result as Receipt | null) : null;
      const rBlock = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined;

      if (receipt && rBlock !== undefined && (!isBase || rBlock <= latest)) {
        // Canonical (Base) / sequenced (Robinhood) inclusion.
        if (receipt.status === "0x0") update(i, "failed", rBlock, "reverted");
        else update(i, "confirmed", rBlock);
        return;
      }
      if (!isBase) return;

      // Base Flashblocks preconfirmation: a receipt for a block past the canonical
      // head (Flashblocks-aware primary), a receipt from the Flashblocks RPC, or
      // the tx sitting in the Flashblocks `pending` block.
      const fbReceipt = receipt ?? fbReceipts.get(o.sent.id);
      if (fbReceipt) {
        const b = fbReceipt.blockNumber ? Number(BigInt(fbReceipt.blockNumber)) : pendingNumber;
        if (fbReceipt.status === "0x0") update(i, "failed", b, "reverted (preconfirmed)");
        else update(i, "preconfirmed", b);
        return;
      }
      if (pendingTxs.has(o.sent.id.toLowerCase())) update(i, "preconfirmed", pendingNumber);
    });
  }
}

/** Router for Base only. */
export function createBaseRouter(cfg: Omit<ChainConfig, "chain">, opts?: L2RouterOptions): L2Router {
  return new L2Router([{ ...cfg, chain: "base" }], opts);
}

/** Router for Robinhood Chain only. */
export function createRobinhoodRouter(cfg: Omit<ChainConfig, "chain">, opts?: L2RouterOptions): L2Router {
  return new L2Router([{ ...cfg, chain: "robinhood" }], opts);
}

function isL2(chain: ChainId): chain is L2Chain {
  return chain === "base" || chain === "robinhood";
}

/** JSON-RPC batch when supported, otherwise parallel single calls. */
async function multi(client: RpcClient, calls: RpcCall[]): Promise<RpcResult[]> {
  if (client.batch && !noBatch.has(client)) {
    try {
      return await client.batch(calls);
    } catch (e) {
      // Only fall back for servers without batch support; other errors surface to the poller.
      if (!(e instanceof BatchUnsupportedError)) throw e;
      noBatch.add(client);
    }
  }
  return Promise.all(calls.map((c) => client.request(c.method, c.params ?? []).then(
    (result): RpcResult => ({ ok: true, result }),
    (error: unknown): RpcResult => ({ ok: false, error: error as never }),
  )));
}

const noBatch = new WeakSet<RpcClient>();

/** A JSON-RPC error object from the node (vs. timeout / network failure). */
function isNodeRejection(e: unknown): boolean {
  return e instanceof RpcError && e.code !== undefined;
}

function isAlreadyKnown(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("already known") || m.includes("known transaction") || m.includes("already imported") || m.includes("already exists") || m.includes("already in pool");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
