// TxRouter for Solana: RPC fan-out + optional Jito block-engine submission,
// rebroadcast-until-confirmed-or-expired confirmation.

import {
  createSolanaRpc,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type GetBlockHeightApi,
  type GetRecentPrioritizationFeesApi,
  type GetSignatureStatusesApi,
  type IsBlockhashValidApi,
  type Rpc,
  type SendTransactionApi,
  type Signature,
} from "@solana/kit";
import type { ChainConfig, ChainId, FeeStrategy, PreparedTx, SentTx, TxOutcome, TxRouter, TxStatus } from "@mint-engine/core";
import { estimatePriorityFee, type EstimatePriorityFeeOptions, type PriorityFeeEstimate } from "./fees.js";
import { inspectWireTransaction } from "./wire.js";

export type SolanaRouterRpc = Rpc<
  SendTransactionApi & GetSignatureStatusesApi & GetBlockHeightApi & IsBlockhashValidApi & GetRecentPrioritizationFeesApi
>;

export interface SolanaRouterOptions {
  /** Resend unconfirmed txs this often. Default 1500 ms. */
  rebroadcastIntervalMs?: number;
  /** Poll getSignatureStatuses this often. Default 400 ms. */
  pollIntervalMs?: number;
  /** Default confirm() timeout. Default 90 s (longer than a blockhash lifetime). */
  defaultTimeoutMs?: number;
  /** Per-request timeout for send calls. Default 3 s. */
  requestTimeoutMs?: number;
  /**
   * How txs go to Jito. "bundle" (default) sends up to 5 txs as ONE atomic bundle: if any tx
   * fails, Jito drops the whole bundle. The public path still carries them unless
   * privateSubmission is set. "per-tx" uses Jito sendTransaction for each tx.
   */
  jitoMode?: "bundle" | "per-tx";
  /** Optional Jito auth UUID, sent as the `x-jito-auth` header. */
  jitoAuth?: string;
  /** Inject RPC clients (tests). Defaults to `createSolanaRpc(url)`. */
  rpcFactory?: (url: string) => SolanaRouterRpc;
  /** Inject fetch for Jito calls (tests). */
  fetch?: typeof fetch;
  /** Non-fatal errors (failed endpoint, poll error). Messages never contain key material. */
  onError?: (err: unknown, context: string) => void;
}

/** Thrown when a different tx would be submitted for a wallet whose previous tx may still land. */
export class DoubleSubmitError extends Error {
  constructor(readonly walletId: string, readonly pendingSignature: string, reason: string) {
    super(`wallet ${walletId} already has tx ${pendingSignature} in flight (${reason}); refusing to submit a different tx`);
    this.name = "DoubleSubmitError";
  }
}

interface Tracked {
  signature: string;
  walletId: string;
  base64: Base64EncodedWireTransaction;
  /** Recent blockhash. Undefined for durable-nonce txs, which don't expire by blockhash. */
  blockhash?: string;
  lastValidBlockHeight?: number;
  /** privateSubmission: only the Jito block engine ever sees this tx. */
  jitoOnly: boolean;
  /** Set once the tx is confirmed, failed or expired. Only then may the wallet send a different tx. */
  terminal: boolean;
  lastSendError?: string;
}

interface Endpoint {
  label: string;
  rpc: SolanaRouterRpc;
}

const SIG_STATUS_BATCH = 256;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stringifyErr(e: unknown): string {
  return JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function endpointLabel(url: string, i: number): string {
  // Host only: RPC URLs often carry API keys in the path or query.
  try {
    return `rpc${i}:${new URL(url).host}`;
  } catch {
    return `rpc${i}`;
  }
}

/** Resolve the Jito block-engine bundle and transaction endpoints from a base URL. */
export function jitoEndpoints(privateRelayUrl: string): { bundles: string; transactions: string } {
  const base = privateRelayUrl.replace(/\/+$/, "").replace(/\/api\/v1(\/(bundles|transactions))?$/, "");
  return { bundles: `${base}/api/v1/bundles`, transactions: `${base}/api/v1/transactions` };
}

/** Max txs Jito accepts in one bundle. */
export const JITO_MAX_BUNDLE_SIZE = 5;

export class SolanaTxRouter implements TxRouter {
  readonly chains: ChainId[] = ["solana"];
  private readonly endpoints: Endpoint[];
  private readonly primary: SolanaRouterRpc;
  private readonly byWallet = new Map<string, Tracked>();
  private readonly bySig = new Map<string, Tracked>();
  private readonly opts: Required<Pick<SolanaRouterOptions, "rebroadcastIntervalMs" | "pollIntervalMs" | "defaultTimeoutMs" | "requestTimeoutMs">>;
  private readonly fetchImpl: typeof fetch;
  /** Serializes send()'s check-and-register phase so concurrent calls can't both pass the guard. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ChainConfig, private readonly options: SolanaRouterOptions = {}) {
    if (config.chain !== "solana") throw new Error(`SolanaTxRouter needs chain "solana", got "${config.chain}"`);
    const factory = options.rpcFactory ?? ((url: string) => createSolanaRpc(url) as SolanaRouterRpc);
    const urls = [config.rpcUrl, ...(config.extraRpcUrls ?? [])];
    this.endpoints = urls.map((url, i) => ({ label: endpointLabel(url, i), rpc: factory(url) }));
    this.primary = this.endpoints[0]!.rpc;
    this.opts = {
      rebroadcastIntervalMs: options.rebroadcastIntervalMs ?? 1500,
      pollIntervalMs: options.pollIntervalMs ?? 400,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 90_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 3000,
    };
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Priority fee from recent fees on `accounts`, capped by `fees.maxTotalFee`. */
  estimatePriorityFee(accounts: ReadonlyArray<string>, percentile: number, opts?: EstimatePriorityFeeOptions): Promise<PriorityFeeEstimate> {
    return estimatePriorityFee(this.primary, accounts, percentile, opts);
  }

  /** Signature of the wallet's tx that may still land, if any. */
  pendingFor(walletId: string): string | undefined {
    const t = this.byWallet.get(walletId);
    return t && !t.terminal ? t.signature : undefined;
  }

  /**
   * Broadcast signed txs. Every tx goes simultaneously to the primary RPC and to every
   * `extraRpcUrls` entry (skipPreflight, maxRetries 0). With `jitoTip` it also goes to the
   * Jito block engine. With `privateSubmission` it goes ONLY to Jito, including rebroadcasts.
   *
   * Throws DoubleSubmitError, before anything is broadcast, if a wallet would get a different
   * tx while its previous one can still land. `err.walletId` says which wallet, so the
   * caller can drop it and resend the rest.
   */
  async send(signed: Array<{ prepared: PreparedTx; signed: Uint8Array }>, fees: FeeStrategy): Promise<SentTx[]> {
    const tip = fees.jitoTip ? BigInt(fees.jitoTip) : 0n;
    const jitoOnly = fees.privateSubmission === true;
    if (jitoOnly && !this.config.privateRelayUrl) {
      throw new Error("privateSubmission requested but ChainConfig.privateRelayUrl (Jito block engine) is not set");
    }
    if (jitoOnly && tip <= 0n) {
      throw new Error("privateSubmission needs FeeStrategy.jitoTip > 0; the tip transfer must be inside the signed tx (getJitoTipInstruction)");
    }
    // A tip without a relay URL is still paid (it's in the tx); we just send publicly.
    const relayUrl = jitoOnly || tip > 0n ? this.config.privateRelayUrl : undefined;

    // 1. Decode and check for conflicts inside this call (sync, nothing on the wire yet).
    const batch = new Map<string, Tracked>(); // walletId -> tracked, for this call
    const entries = signed.map(({ prepared, signed: bytes }) => {
      if (prepared.chain !== "solana") throw new Error(`SolanaTxRouter cannot send ${prepared.chain} tx`);
      const info = inspectWireTransaction(bytes);
      const existing = batch.get(prepared.walletId);
      if (existing && existing.signature !== info.signature) {
        throw new DoubleSubmitError(prepared.walletId, existing.signature, "two different txs in one send() call");
      }
      const t: Tracked = existing ?? {
        signature: info.signature,
        walletId: prepared.walletId,
        base64: info.base64 as Base64EncodedWireTransaction,
        blockhash: info.durableNonce ? undefined : info.lifetimeToken,
        lastValidBlockHeight: info.durableNonce ? undefined : prepared.validUntil,
        jitoOnly,
        terminal: false,
      };
      batch.set(prepared.walletId, t);
      return { prepared, t };
    });

    // 2. Check against in-flight txs and register, serialized across concurrent send() calls.
    const unique = await this.serialized(async () => {
      for (const t of batch.values()) {
        const prev = this.byWallet.get(t.walletId);
        if (prev && !prev.terminal && prev.signature !== t.signature) await this.assertSuperseded(prev);
      }
      const out: Tracked[] = [];
      for (const t of batch.values()) {
        const prev = this.bySig.get(t.signature);
        const rec = prev && !prev.terminal ? prev : t;
        if (!jitoOnly) rec.jitoOnly = false; // once public, public from then on
        this.byWallet.set(rec.walletId, rec);
        this.bySig.set(rec.signature, rec);
        out.push(rec);
      }
      return out;
    });

    // 3. Fan out simultaneously: every tx to every RPC (unless private), plus Jito.
    const sentAt = Date.now();
    const via = new Map<string, string[]>(unique.map((t) => [t.signature, []]));
    const rpcSends = jitoOnly
      ? []
      : unique.flatMap((t) =>
          this.endpoints.map(async (ep) => {
            try {
              await this.sendRaw(ep, t);
              via.get(t.signature)!.push(ep.label);
            } catch (e) {
              t.lastSendError = `${ep.label}: ${errMessage(e)}`;
              this.options.onError?.(e, `send ${t.signature} via ${ep.label}`);
            }
          }),
        );
    const jito = relayUrl ? this.sendJito(relayUrl, unique, via) : Promise.resolve();
    await Promise.all([...rpcSends, jito]);

    return entries.map(({ prepared, t }) => ({
      chain: "solana" as const,
      walletId: prepared.walletId,
      id: t.signature,
      sentAt,
      via: [...via.get(t.signature)!],
    }));
  }

  /**
   * Poll getSignatureStatuses (batched) and rebroadcast unseen txs every ~1.5 s until each is
   * confirmed, failed or expired (block height > lastValidBlockHeight, or blockhash invalid when
   * validUntil is unknown), or the timeout passes. At timeout the current status is returned.
   */
  async confirm(sent: SentTx[], opts: { timeoutMs?: number; acceptPreconf?: boolean } = {}): Promise<TxOutcome[]> {
    const deadline = Date.now() + (opts.timeoutMs ?? this.opts.defaultTimeoutMs);
    const outcomes = new Map<string, TxOutcome>();
    for (const s of sent) if (!outcomes.has(s.id)) outcomes.set(s.id, { sent: s, status: "sent" });
    const isDone = (st: TxStatus) =>
      st === "confirmed" || st === "failed" || st === "expired" || (opts.acceptPreconf === true && st === "preconfirmed");
    const pending = () => [...outcomes.values()].filter((o) => !isDone(o.status));
    let lastBroadcast = Date.now();

    while (pending().length > 0) {
      const open = pending();
      try {
        // Expiry facts are read BEFORE statuses, so "not found" + "expired" can't race a late landing.
        const expired = await this.expiredSet(open.map((o) => o.sent.id));
        const sigs = open.map((o) => o.sent.id);
        const statuses = await this.statuses(sigs);
        sigs.forEach((sig, i) => {
          const o = outcomes.get(sig)!;
          const st = statuses[i];
          if (st?.err) {
            o.status = "failed";
            o.error = stringifyErr(st.err);
            o.slotOrBlock = Number(st.slot);
          } else if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            o.status = "confirmed";
            o.slotOrBlock = Number(st.slot);
            o.confirmedAt = Date.now();
          } else if (st) {
            o.status = "preconfirmed";
            o.slotOrBlock = Number(st.slot);
          } else if (expired.has(sig)) {
            o.status = "expired";
            const last = this.bySig.get(sig)?.lastSendError;
            o.error = `blockhash expired before the tx landed${last ? ` (last send error: ${last})` : ""}`;
          } else if (o.status === "preconfirmed") {
            // Seen as processed, now gone: its fork was dropped. Resume rebroadcasting.
            o.status = "sent";
            o.slotOrBlock = undefined;
          }
          const tracked = this.bySig.get(sig);
          if (tracked && (o.status === "confirmed" || o.status === "failed" || o.status === "expired")) this.markTerminal(tracked);
        });
      } catch (e) {
        this.options.onError?.(e, "confirm poll");
      }

      const still = pending();
      if (still.length === 0 || Date.now() >= deadline) break;

      if (Date.now() - lastBroadcast >= this.opts.rebroadcastIntervalMs) {
        lastBroadcast = Date.now();
        // Only resend txs not seen at all. A processed tx is already in a block.
        for (const o of still) {
          const t = this.bySig.get(o.sent.id);
          if (!t || o.status !== "sent") continue;
          this.rebroadcast(t);
        }
      }
      await sleep(Math.min(this.opts.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    return sent.map((s) => ({ ...outcomes.get(s.id)!, sent: s }));
  }

  // ---------- internals ----------

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.catch(() => {});
    return run;
  }

  /** Terminal txs free their wallet and drop their bytes, so memory doesn't grow without bound. */
  private markTerminal(t: Tracked): void {
    t.terminal = true;
    if (this.bySig.get(t.signature) === t) this.bySig.delete(t.signature);
    if (this.byWallet.get(t.walletId) === t) this.byWallet.delete(t.walletId);
  }

  private rebroadcast(t: Tracked): void {
    if (t.jitoOnly) {
      if (!this.config.privateRelayUrl) return;
      this.jitoPost(jitoEndpoints(this.config.privateRelayUrl).transactions, "sendTransaction", [t.base64, { encoding: "base64" }]).catch((e) => {
        t.lastSendError = `jito: ${errMessage(e)}`;
      });
      return;
    }
    for (const ep of this.endpoints) {
      this.sendRaw(ep, t).catch((e) => {
        t.lastSendError = `${ep.label}: ${errMessage(e)}`;
      });
    }
  }

  private async sendRaw(ep: Endpoint, t: Tracked): Promise<void> {
    await ep.rpc
      .sendTransaction(t.base64, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
      .send({ abortSignal: AbortSignal.timeout(this.opts.requestTimeoutMs) });
  }

  private async jitoPost(url: string, method: string, params: unknown[]): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.jitoAuth) headers["x-jito-auth"] = this.options.jitoAuth;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(`jito ${method} failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }

  private async sendJito(relayUrl: string, txs: Tracked[], via: Map<string, string[]>): Promise<void> {
    const ep = jitoEndpoints(relayUrl);
    const fail = (e: unknown, ts: Tracked[]) => {
      for (const t of ts) t.lastSendError = `jito: ${errMessage(e)}`;
      this.options.onError?.(e, "jito");
    };
    if ((this.options.jitoMode ?? "bundle") === "bundle" && txs.length <= JITO_MAX_BUNDLE_SIZE) {
      try {
        await this.jitoPost(ep.bundles, "sendBundle", [txs.map((t) => t.base64), { encoding: "base64" }]);
        for (const t of txs) via.get(t.signature)!.push("jito:bundle");
      } catch (e) {
        fail(e, txs);
      }
      return;
    }
    await Promise.all(
      txs.map(async (t) => {
        try {
          await this.jitoPost(ep.transactions, "sendTransaction", [t.base64, { encoding: "base64" }]);
          via.get(t.signature)!.push("jito:tx");
        } catch (e) {
          fail(e, [t]);
        }
      }),
    );
  }

  private async statuses(sigs: string[]) {
    const out: Array<Awaited<ReturnType<ReturnType<SolanaRouterRpc["getSignatureStatuses"]>["send"]>>["value"][number]> = [];
    for (let i = 0; i < sigs.length; i += SIG_STATUS_BATCH) {
      const chunk = sigs.slice(i, i + SIG_STATUS_BATCH) as Signature[];
      const res = await this.primary.getSignatureStatuses(chunk, { searchTransactionHistory: false }).send();
      out.push(...res.value);
    }
    return out;
  }

  /** Signatures whose blockhash can no longer land. */
  private async expiredSet(sigs: string[]): Promise<Set<string>> {
    const expired = new Set<string>();
    const tracked = sigs.map((s) => this.bySig.get(s)).filter((t): t is Tracked => t !== undefined);
    if (tracked.some((t) => t.lastValidBlockHeight !== undefined)) {
      const height = Number(await this.primary.getBlockHeight({ commitment: "confirmed" }).send());
      for (const t of tracked) if (t.lastValidBlockHeight !== undefined && height > t.lastValidBlockHeight) expired.add(t.signature);
    }
    // No lastValidBlockHeight known: ask whether the blockhash is still valid. Durable-nonce txs never expire here.
    const byHash = new Map<string, Tracked[]>();
    for (const t of tracked) {
      if (t.lastValidBlockHeight !== undefined || t.blockhash === undefined) continue;
      byHash.set(t.blockhash, [...(byHash.get(t.blockhash) ?? []), t]);
    }
    await Promise.all(
      [...byHash].map(async ([hash, ts]) => {
        const res = await this.primary.isBlockhashValid(hash as Blockhash, { commitment: "confirmed" }).send();
        if (!res.value) for (const t of ts) expired.add(t.signature);
      }),
    );
    return expired;
  }

  /** Marks `prev` terminal if it can no longer land (or already confirmed / failed), else throws. */
  private async assertSuperseded(prev: Tracked): Promise<void> {
    const expired = await this.expiredSet([prev.signature]);
    const [st] = await this.statuses([prev.signature]);
    if (st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      this.markTerminal(prev);
      return;
    }
    if (st) throw new DoubleSubmitError(prev.walletId, prev.signature, "processed, not yet confirmed");
    if (expired.has(prev.signature)) {
      this.markTerminal(prev);
      return;
    }
    throw new DoubleSubmitError(prev.walletId, prev.signature, prev.blockhash ? "blockhash still valid" : "durable-nonce tx may still land");
  }
}

export function createSolanaRouter(config: ChainConfig, options?: SolanaRouterOptions): SolanaTxRouter {
  return new SolanaTxRouter(config, options);
}
