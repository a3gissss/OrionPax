// Local nonce manager (self-contained for the L2 router package).
//
// The first `next(address)` call fetches the pending nonce once; after that nonces
// are handed out locally, so 10 wallets x N txs can be built without extra RPC
// round trips. Concurrent callers for the same address get distinct, gap-free values.

import type { RpcClient } from "./keepalive.js";

export class NonceManager {
  /** Resolved next-nonce per address (lowercased). Always read after any await. */
  private readonly state = new Map<string, number>();
  /** In-flight chain reads, shared by concurrent first callers. */
  private readonly loading = new Map<string, Promise<void>>();

  constructor(private readonly rpc: RpcClient) {}

  /** Reserve and return the next nonce for `address`. */
  async next(address: string): Promise<number> {
    return this.reserve(address, 1);
  }

  /** Reserve `count` consecutive nonces; returns the first one. */
  async reserve(address: string, count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
    const k = await this.ensure(address);
    const first = this.state.get(k)!;
    this.state.set(k, first + count);
    return first;
  }

  /** The nonce the next call would return, without reserving it. */
  async peek(address: string): Promise<number> {
    return this.state.get(await this.ensure(address))!;
  }

  /** Force a known value (for example after a confirmed external tx). */
  set(address: string, nonce: number): void {
    this.state.set(key(address), nonce);
  }

  /** Forget local state; the next call re-reads the pending nonce from the chain. */
  reset(address?: string): void {
    if (address === undefined) {
      this.state.clear();
      this.loading.clear();
    } else {
      this.state.delete(key(address));
      this.loading.delete(key(address));
    }
  }

  /** Make sure `state` has an entry for `address`; returns its key. */
  private async ensure(address: string): Promise<string> {
    const k = key(address);
    while (!this.state.has(k)) {
      let p = this.loading.get(k);
      if (!p) {
        p = this.rpc.request<string>("eth_getTransactionCount", [address, "pending"]).then((hex) => {
          // A concurrent set() wins over the chain read.
          if (!this.state.has(k)) this.state.set(k, Number(BigInt(hex)));
        });
        this.loading.set(k, p);
        const mine = p;
        // Don't cache the in-flight promise past completion; failures can be retried.
        p.finally(() => { if (this.loading.get(k) === mine) this.loading.delete(k); }).catch(() => undefined);
      }
      await p;
    }
    return k;
  }
}

function key(address: string): string {
  return address.toLowerCase();
}
