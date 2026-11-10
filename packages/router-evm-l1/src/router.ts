import type { ChainConfig, ChainId, FeeStrategy, PreparedTx, SentTx, TxOutcome, TxRouter } from "@mint-engine/core";
import {
  bytesToHex,
  createPublicClient,
  http,
  keccak256,
  toHex,
  TransactionReceiptNotFoundError,
  webSocket,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface BundleOptions {
  /** Builder endpoints accepting `eth_sendBundle` (Flashbots-compatible). */
  builderUrls: string[];
  /**
   * Throwaway reputation/auth key used ONLY for the `X-Flashbots-Signature` header.
   * Never a funded wallet key.
   */
  authKey: Hex;
  /** How many consecutive blocks to target, starting at the next block. Default 2 (N, N+1). */
  blocks?: number;
}

export interface EvmL1RouterOptions {
  config: ChainConfig;
  /** Optional bundle submission used when `fees.privateSubmission` is set. */
  bundle?: BundleOptions;
  /** Receipt polling interval when no wsUrl is configured. Default 500 ms. */
  pollIntervalMs?: number;
  /** Per-request timeout for submissions. Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Override for tests. */
  fetch?: typeof fetch;
  /** Override the read client (tests). */
  publicClient?: PublicClient;
}

interface SendRecord {
  /** All endpoints rejected the tx. */
  error?: string;
  /** Bundle-only submission: last targeted block; past it without inclusion → expired. */
  lastTargetBlock?: bigint;
}

export class JsonRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
  }
}

let rpcId = 0;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function isAlreadyKnown(msg: string): boolean {
  return /already known|known transaction|already imported|alreadyknown/i.test(msg);
}

export class EvmL1Router implements TxRouter {
  readonly chains: ChainId[] = ["ethereum"];
  readonly client: PublicClient;
  private readonly cfg: ChainConfig;
  private readonly bundle?: BundleOptions;
  private readonly authAccount?: PrivateKeyAccount;
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly records = new Map<string, SendRecord>();

  constructor(opts: EvmL1RouterOptions) {
    if (opts.config.chain !== "ethereum") throw new Error(`EvmL1Router only handles "ethereum", got "${opts.config.chain}"`);
    this.cfg = opts.config;
    this.bundle = opts.bundle;
    if (opts.bundle) {
      if (opts.bundle.builderUrls.length === 0) throw new Error("bundle.builderUrls must not be empty");
      this.authAccount = privateKeyToAccount(opts.bundle.authKey);
    }
    this.fetchFn = opts.fetch ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.client =
      opts.publicClient ??
      (createPublicClient({
        transport: opts.config.wsUrl ? webSocket(opts.config.wsUrl) : http(opts.config.rpcUrl),
        pollingInterval: this.pollIntervalMs,
      }) as PublicClient);
  }

  /** Address of the bundle auth key (for builder reputation), if configured. */
  get bundleAuthAddress(): string | undefined {
    return this.authAccount?.address;
  }

  private async rpc<T>(url: string, method: string, params: unknown[], headers: Record<string, string> = {}, body?: string): Promise<T> {
    const payload = body ?? JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: payload,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: { result?: T; error?: { message?: string; code?: number; data?: unknown } };
      try {
        json = JSON.parse(text);
      } catch {
        throw new JsonRpcError(`${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (json.error) throw new JsonRpcError(json.error.message ?? "rpc error", json.error.code, json.error.data);
      if (!res.ok) throw new JsonRpcError(`${method} → HTTP ${res.status}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Flashbots auth header: `<address>:<sig over keccak256(body) hex string>`. */
  async flashbotsSignature(body: string): Promise<string> {
    if (!this.authAccount) throw new Error("no bundle auth key configured");
    const sig = await this.authAccount.signMessage({ message: keccak256(toHex(body)) });
    return `${this.authAccount.address}:${sig}`;
  }

  async send(signed: Array<{ prepared: PreparedTx; signed: Uint8Array }>, fees: FeeStrategy): Promise<SentTx[]> {
    for (const { prepared } of signed) {
      if (prepared.chain !== "ethereum") throw new Error(`EvmL1Router cannot send ${prepared.chain} tx`);
    }
    const items = signed.map(({ prepared, signed: raw }) => {
      const hex = bytesToHex(raw);
      return { prepared, raw: hex, hash: keccak256(hex) as Hash };
    });
    if (items.length === 0) return [];
    return fees.privateSubmission ? this.sendPrivate(items) : this.sendPublic(items);
  }

  /** Submit one raw tx to many endpoints in parallel; resolves with the endpoints that accepted it. */
  private async fanOut(urls: string[], raw: Hex, hash: Hash, tag: string): Promise<{ via: string[]; errors: string[] }> {
    const via: string[] = [];
    const errors: string[] = [];
    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await this.rpc<Hash>(url, "eth_sendRawTransaction", [raw]);
          if (typeof res !== "string") {
            errors.push(`${hostOf(url)}: no tx hash in response`);
            return;
          }
          if (res.toLowerCase() !== hash.toLowerCase()) {
            errors.push(`${hostOf(url)}: returned unexpected hash ${res}`);
            return;
          }
          via.push(`${tag}:${hostOf(url)}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (isAlreadyKnown(msg)) via.push(`${tag}:${hostOf(url)}`);
          else errors.push(`${hostOf(url)}: ${msg}`);
        }
      }),
    );
    return { via, errors };
  }

  private async sendPublic(items: Array<{ prepared: PreparedTx; raw: Hex; hash: Hash }>): Promise<SentTx[]> {
    const urls = [this.cfg.rpcUrl, ...(this.cfg.extraRpcUrls ?? [])];
    return Promise.all(
      items.map(async ({ prepared, raw, hash }) => {
        const sentAt = Date.now();
        const { via, errors } = await this.fanOut(urls, raw, hash, "rpc");
        this.records.set(hash, via.length === 0 ? { error: errors.join("; ") || "rejected" } : {});
        return { chain: prepared.chain, walletId: prepared.walletId, id: hash, sentAt, via };
      }),
    );
  }

  private async sendPrivate(items: Array<{ prepared: PreparedTx; raw: Hex; hash: Hash }>): Promise<SentTx[]> {
    const relay = this.cfg.privateRelayUrl;
    if (!relay && !this.bundle) {
      // Refuse to silently leak a private submission to the public mempool.
      throw new Error("privateSubmission requested but no privateRelayUrl or bundle builders configured");
    }
    let targets: bigint[] = [];
    let headError: string | undefined;
    if (this.bundle) {
      try {
        const head = await this.client.getBlockNumber({ cacheTime: 0 });
        const n = Math.max(1, this.bundle.blocks ?? 2);
        targets = Array.from({ length: n }, (_, i) => head + 1n + BigInt(i));
      } catch (e) {
        // Still submit via the relay if there is one; bundles need a target block.
        headError = `bundle skipped, block number unavailable: ${e instanceof Error ? e.message : String(e)}`;
        if (!relay) throw new Error(headError);
      }
    }

    return Promise.all(
      items.map(async ({ prepared, raw, hash }) => {
        const sentAt = Date.now();
        const via: string[] = [];
        const errors: string[] = [];
        const tasks: Promise<void>[] = [];
        let relayOk = false;
        let bundleOk = false;
        if (relay) {
          tasks.push(
            this.fanOut([relay], raw, hash, "relay").then((r) => {
              via.push(...r.via);
              errors.push(...r.errors);
              relayOk = r.via.length > 0;
            }),
          );
        }
        if (headError) errors.push(headError);
        if (this.bundle && targets.length > 0) {
          // One bundle per tx so one wallet's revert can't sink the others.
          for (const url of this.bundle.builderUrls) {
            tasks.push(
              (async () => {
                let any = false;
                await Promise.all(
                  targets.map(async (block) => {
                    try {
                      const body = JSON.stringify({
                        jsonrpc: "2.0",
                        id: ++rpcId,
                        method: "eth_sendBundle",
                        params: [{ txs: [raw], blockNumber: toHex(block) }],
                      });
                      const sig = await this.flashbotsSignature(body);
                      await this.rpc(url, "eth_sendBundle", [], { "X-Flashbots-Signature": sig }, body);
                      any = true;
                    } catch (e) {
                      errors.push(`bundle ${hostOf(url)}@${block}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }),
                );
                if (any) {
                  via.push(`bundle:${hostOf(url)}`);
                  bundleOk = true;
                }
              })(),
            );
          }
        }
        await Promise.all(tasks);
        const rec: SendRecord = {};
        if (!relayOk && !bundleOk) rec.error = errors.join("; ") || "rejected";
        // Bundle-only: inclusion is bounded by the targeted blocks.
        else if (!relayOk && bundleOk) rec.lastTargetBlock = targets[targets.length - 1];
        this.records.set(hash, rec);
        return { chain: prepared.chain, walletId: prepared.walletId, id: hash, sentAt, via };
      }),
    );
  }

  /**
   * Watch receipts until every tx is terminal or the timeout passes. Polls the head every
   * `pollIntervalMs` (over ws when configured) and checks receipts immediately and on each new
   * block. Reverted → "failed"; bundle-only txs past their last target block → "expired".
   */
  async confirm(sent: SentTx[], opts: { timeoutMs?: number; acceptPreconf?: boolean } = {}): Promise<TxOutcome[]> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const outcomes = new Map<number, TxOutcome>();
    const pending = new Set<number>();
    const settle = (i: number, o: TxOutcome) => {
      pending.delete(i);
      outcomes.set(i, o);
      this.records.delete(o.sent.id);
    };
    sent.forEach((s, i) => {
      const rec = this.records.get(s.id);
      if (rec?.error) settle(i, { sent: s, status: "failed", error: rec.error });
      else pending.add(i);
    });

    const check = async (head: bigint | undefined): Promise<void> => {
      await Promise.all(
        [...pending].map(async (i) => {
          const s = sent[i]!;
          let receipt;
          let notFound = false;
          try {
            receipt = await this.client.getTransactionReceipt({ hash: s.id as Hash });
          } catch (e) {
            // Only a definitive "not found" counts toward expiry; transient errors just retry.
            notFound = e instanceof TransactionReceiptNotFoundError;
          }
          if (receipt) {
            const ok = receipt.status === "success";
            settle(i, {
              sent: s,
              status: ok ? "confirmed" : "failed",
              slotOrBlock: Number(receipt.blockNumber),
              confirmedAt: Date.now(),
              ...(ok ? {} : { error: "reverted" }),
            });
            return;
          }
          const last = this.records.get(s.id)?.lastTargetBlock;
          // One block of grace so a lagging node can't turn an included bundle into "expired".
          if (notFound && last !== undefined && head !== undefined && head > last + 1n) {
            settle(i, { sent: s, status: "expired", error: `bundle not included by block ${last}` });
          }
        }),
      );
    };

    let lastHead: bigint | undefined;
    let first = true;
    while (pending.size > 0 && Date.now() < deadline) {
      let head: bigint | undefined;
      try {
        head = await this.client.getBlockNumber({ cacheTime: 0 });
      } catch {
        head = undefined; // transient; receipts are still checked on the first pass
      }
      if (first || (head !== undefined && (lastHead === undefined || head > lastHead))) {
        first = false;
        await check(head);
        if (head !== undefined) lastHead = head;
      }
      if (pending.size === 0) break;
      const wait = Math.min(this.pollIntervalMs, deadline - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    return sent.map((s, i) => outcomes.get(i) ?? { sent: s, status: "sent", error: "timeout waiting for receipt" });
  }
}

export function createEvmL1Router(opts: EvmL1RouterOptions): EvmL1Router {
  return new EvmL1Router(opts);
}
