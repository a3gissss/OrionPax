// End-to-end against a local anvil (Base chain id 8453) with a minimal inline viem adapter/router.
// Never points at a public network. Skipped when the RPC is unreachable.
import { describe, expect, it } from "vitest";
import {
  createPublicClient, http, parseTransaction, serializeTransaction, toBytes, toHex,
} from "viem";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type {
  ChainAdapter, EngineEvent, MintTarget, PreparedTx, SentTx, TxOutcome, TxRouter, WalletRef, WalletSigner,
} from "@mint-engine/core";
import { Engine } from "../src/index.js";

// ---------- real chain (local anvil) ----------

const RPC = process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546";
// Anvil's well-known public dev mnemonic. Local test chain only.
const DEV_MNEMONIC = "test test test test test test test test test test test junk";

async function anvilUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return res.ok;
  } catch { return false; }
}

const up = await anvilUp();

describe.skipIf(!up)("engine e2e (anvil, chain 8453)", () => {
  it("runs a 10-wallet self-transfer job through the full pipeline", async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const chainId = await client.getChainId();
    expect(chainId).toBe(8453);
    const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i }));
    const wallets: WalletRef[] = accounts.map((a, i) => ({ id: `w${i + 1}`, label: `Dev ${i + 1}`, family: "evm", address: a.address }));
    const byId = new Map(wallets.map((w, i) => [w.id, { wallet: w, account: accounts[i]! }]));

    // Minimal inline adapter: a 0-value self-transfer stands in for the mint call.
    const adapter: ChainAdapter = {
      chain: "base", kind: "nft",
      supports: (t: MintTarget) => t.chain === "base",
      detect: async () => ({ live: true, maxPerWallet: 1 }),
      async prepare(_t, wallet, fees): Promise<PreparedTx> {
        const block = await client.getBlock();
        const nonce = await client.getTransactionCount({ address: wallet.address as Hex, blockTag: "pending" });
        const prio = BigInt(fees.priorityFee ?? "1000000000");
        const tx: TransactionSerializableEIP1559 = {
          type: "eip1559", chainId, nonce, to: wallet.address as Hex, value: 0n, gas: 21_000n,
          maxPriorityFeePerGas: prio, maxFeePerGas: BigInt(fees.maxFee ?? String((block.baseFeePerGas ?? 0n) * 2n + prio)),
        };
        return { chain: "base", walletId: wallet.id, unsigned: toBytes(serializeTransaction(tx)), value: "0", computeOrGas: 21_000, description: `self-transfer ${wallet.label}` };
      },
      async simulate(tx) {
        const p = parseTransaction(toHex(tx.unsigned));
        const w = [...byId.values()].find((x) => x.wallet.id === tx.walletId)!;
        try {
          await client.call({ account: w.account.address, to: p.to!, value: p.value, gas: p.gas });
          return { ok: true, computeOrGasUsed: 21_000 };
        } catch (e) { return { ok: false, error: (e as Error).message }; }
      },
    };

    // Minimal inline router: broadcast all at once, then wait for receipts.
    const router: TxRouter = {
      chains: ["base"],
      async send(signed) {
        return Promise.all(signed.map(async ({ prepared, signed: raw }): Promise<SentTx> => {
          const hash = await client.sendRawTransaction({ serializedTransaction: toHex(raw) });
          return { chain: "base", walletId: prepared.walletId, id: hash, sentAt: Date.now(), via: [RPC] };
        }));
      },
      async confirm(sent, opts) {
        return Promise.all(sent.map(async (s): Promise<TxOutcome> => {
          try {
            const r = await client.waitForTransactionReceipt({ hash: s.id as Hex, timeout: opts?.timeoutMs ?? 30_000 });
            return r.status === "success"
              ? { sent: s, status: "confirmed", slotOrBlock: Number(r.blockNumber), confirmedAt: Date.now() }
              : { sent: s, status: "failed", slotOrBlock: Number(r.blockNumber), error: "reverted" };
          } catch (e) { return { sent: s, status: "expired", error: (e as Error).message }; }
        }));
      },
    };

    const getSigner = (id: string): WalletSigner => {
      const { wallet, account } = byId.get(id)!;
      return {
        wallet,
        async signTransaction(unsigned) {
          const tx = parseTransaction(toHex(unsigned)) as TransactionSerializableEIP1559;
          return toBytes(await account.signTransaction(tx));
        },
      };
    };

    const engine = new Engine({ adapters: [adapter], routers: [router], getSigner });
    const events: EngineEvent[] = [];
    engine.on((e) => events.push(e));
    const job = engine.createJob({
      target: { kind: "nft", chain: "base", address: "0x00000000000000000000000000000000000000aa", quantity: 1 },
      walletIds: wallets.map((w) => w.id), fees: { maxTotalFee: String(10n ** 16n) }, trigger: { type: "time", at: Date.now() + 1500 }, maxRetries: 1,
    });
    const view = await engine.run(job.id);

    expect(view.status).toBe("done");
    expect(view.outcomes).toHaveLength(10);
    expect(view.outcomes.every((o) => o.status === "confirmed" && /^0x[0-9a-f]{64}$/.test(o.sent.id))).toBe(true);
    for (const o of view.outcomes) {
      const tx = await client.getTransaction({ hash: o.sent.id as Hex });
      expect(tx.from.toLowerCase()).toBe(byId.get(o.sent.walletId)!.wallet.address.toLowerCase());
    }
    // Pre-armed: every tx was signed before the job entered "firing".
    const firingIdx = events.findIndex((e) => e.type === "job.status" && e.status === "firing");
    expect(events.slice(0, firingIdx).filter((e) => e.type === "tx.status" && e.status === "signed")).toHaveLength(10);
  }, 60_000);
});
