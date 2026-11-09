import { getAddress, type Address } from "viem";

/** Minimal client surface the nonce manager needs (a viem PublicClient satisfies it). */
export interface NonceSource {
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
}

interface AddressState {
  next: number;
  /** Chain pending count at last seed/resync; nonces below it are already used. */
  floor: number;
  /** Nonces handed back via release(), reused lowest-first before `next`. */
  released: number[];
}

/**
 * Per-address local nonce tracking. Seeded lazily from `getTransactionCount(pending)` so many txs
 * can be prepared without a round trip each. All operations per address are serialized.
 */
export class NonceManager {
  private readonly state = new Map<string, AddressState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly source: NonceSource) {}

  private key(address: string): Address {
    return getAddress(address);
  }

  private withLock<T>(address: Address, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(address) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(address, tail);
    void tail.then(() => {
      if (this.locks.get(address) === tail) this.locks.delete(address);
    });
    return run;
  }

  private async fetch(address: Address): Promise<AddressState> {
    const next = await this.source.getTransactionCount({ address, blockTag: "pending" });
    const s: AddressState = { next, floor: next, released: [] };
    this.state.set(address, s);
    return s;
  }

  /** Reserve the next nonce for `address`. */
  reserve(address: string): Promise<number> {
    const a = this.key(address);
    return this.withLock(a, async () => {
      const s = this.state.get(a) ?? (await this.fetch(a));
      if (s.released.length > 0) return s.released.shift()!;
      return s.next++;
    });
  }

  /** Give back a reserved nonce that was never broadcast (e.g. signing/simulation failed). */
  release(address: string, nonce: number): Promise<void> {
    const a = this.key(address);
    return this.withLock(a, async () => {
      const s = this.state.get(a);
      if (!s || nonce < s.floor || nonce >= s.next || s.released.includes(nonce)) return;
      if (nonce === s.next - 1) {
        s.next--;
        // Collapse any released nonces now at the tip.
        s.released.sort((x, y) => x - y);
        while (s.released.length > 0 && s.released[s.released.length - 1] === s.next - 1) {
          s.released.pop();
          s.next--;
        }
      } else {
        s.released.push(nonce);
        s.released.sort((x, y) => x - y);
      }
    });
  }

  /** Drop local state and re-read the pending nonce from the chain (after "nonce too low", drops, etc). */
  resync(address: string): Promise<number> {
    const a = this.key(address);
    return this.withLock(a, async () => (await this.fetch(a)).next);
  }

  /** Next nonce that would be handed out (undefined if not seeded yet). */
  peek(address: string): number | undefined {
    const s = this.state.get(this.key(address));
    if (!s) return undefined;
    return s.released[0] ?? s.next;
  }

  /** Forget everything (or one address). */
  reset(address?: string): Promise<void> {
    if (address === undefined) {
      const all = [...this.state.keys()];
      return Promise.all(all.map((a) => this.reset(a))).then(() => undefined);
    }
    const a = this.key(address);
    return this.withLock(a, async () => {
      this.state.delete(a);
    });
  }
}

/** True when an RPC error message indicates a nonce problem that a resync can fix. */
export function isNonceError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /nonce too (low|high)|invalid nonce|nonce has already been used|replacement transaction underpriced|already imported|oldnonce/.test(
    msg,
  );
}
