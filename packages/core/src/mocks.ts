// Deterministic in-memory mocks so engine/server/web units can test without chains.

import type {
  ChainAdapter, ChainId, FeeStrategy, MintKind, MintState, MintTarget, PreparedTx,
  SentTx, SimulationResult, TxOutcome, TxRouter, WalletRef, WalletSigner,
} from "./types.js";

export class MockAdapter implements ChainAdapter {
  constructor(
    readonly chain: ChainId = "base",
    readonly kind: MintKind = "nft",
    public state: MintState = { live: true, pricePerUnit: "0", maxPerWallet: 2 },
  ) {}
  supports(t: MintTarget) { return t.chain === this.chain && t.kind === this.kind; }
  async detect(): Promise<MintState> { return { ...this.state }; }
  async prepare(target: MintTarget, wallet: WalletRef, _fees: FeeStrategy): Promise<PreparedTx> {
    return {
      chain: this.chain,
      walletId: wallet.id,
      unsigned: new TextEncoder().encode(`mock:${wallet.id}:${JSON.stringify(target)}`),
      value: "0",
      description: `mock ${this.kind} mint for ${wallet.label}`,
    };
  }
  async simulate(): Promise<SimulationResult> { return { ok: true, computeOrGasUsed: 100_000 }; }
}

export class MockRouter implements TxRouter {
  sent: SentTx[] = [];
  /** walletIds whose txs should fail. */
  failWallets = new Set<string>();
  constructor(readonly chains: ChainId[] = ["base"]) {}
  async send(signed: Array<{ prepared: PreparedTx; signed: Uint8Array }>): Promise<SentTx[]> {
    const out = signed.map(({ prepared }, i) => ({
      chain: prepared.chain, walletId: prepared.walletId,
      id: `mocktx_${this.sent.length + i}_${prepared.walletId}`, sentAt: Date.now(), via: ["mock"],
    }));
    this.sent.push(...out);
    return out;
  }
  async confirm(sent: SentTx[]): Promise<TxOutcome[]> {
    return sent.map((s) => this.failWallets.has(s.walletId)
      ? { sent: s, status: "failed", error: "mock failure" }
      : { sent: s, status: "confirmed", slotOrBlock: 1, confirmedAt: Date.now() });
  }
}

export function mockWallets(n: number, family: "solana" | "evm" = "evm"): WalletRef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i + 1}`, label: `Wallet ${i + 1}`, family,
    address: family === "evm" ? `0x${(i + 1).toString(16).padStart(40, "0")}` : `Mock${i + 1}`,
  }));
}

export function mockSigner(wallet: WalletRef): WalletSigner {
  return { wallet, async signTransaction(u) { return u; } };
}
