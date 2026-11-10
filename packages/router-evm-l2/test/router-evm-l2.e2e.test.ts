// E2E against local anvil chains only (docker). Never mainnet RPCs, never real keys.
//   E2E_BASE_RPC      default http://127.0.0.1:8546 (chain 8453, 1 s blocks)
//   E2E_ROBINHOOD_RPC default http://127.0.0.1:8547 (chain 4663, 1 s blocks)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToBytes, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { PreparedTx, SentTx, TxOutcome } from "@mint-engine/core";
import { KeepAliveTransport, L2Router, NonceManager, detectTimeboost, type L2Chain, type SendStat } from "../src/index.js";
import { startStubRpc, type StubRpc } from "./stub-rpc.js";

const BASE_RPC = process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546";
const RH_RPC = process.env.E2E_ROBINHOOD_RPC ?? "http://127.0.0.1:8547";
// Anvil's public, local-only dev mnemonic. These keys hold nothing outside a local devnet.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }));

async function signBatch(router: L2Router, rpc: KeepAliveTransport, chain: L2Chain) {
  const chainId = Number(BigInt(await rpc.request<string>("eth_chainId")));
  const nonces = new NonceManager(rpc);
  const fees = await router.suggestFees(chain, {}, 21_000n);
  return Promise.all(accounts.map(async (acct, i) => {
    const signed = await acct.signTransaction({
      type: "eip1559", chainId, nonce: await nonces.next(acct.address),
      to: acct.address, value: 1n, gas: 21_000n, ...fees,
    });
    const prepared: PreparedTx = { chain, walletId: `w${i + 1}`, unsigned: new Uint8Array(), value: "1", description: "self-transfer" };
    return { prepared, signed: hexToBytes(signed) };
  }));
}

function report(label: string, stats: SendStat[]) {
  const ms = stats.map((s) => s.latencyMs ?? NaN);
  const lines = stats.map((s) => `  ${s.walletId.padEnd(4)} ${s.hash.slice(0, 12)}…  ${(s.latencyMs ?? NaN).toFixed(2)} ms  via ${s.attempts.filter((a) => a.ok).map((a) => a.endpoint).join(",")}`);
  const sorted = [...ms].sort((a, b) => a - b);
  console.log(`[${label}] per-tx send latency (dispatch -> first ack):\n${lines.join("\n")}\n  min ${sorted[0]!.toFixed(2)} / median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} / max ${sorted.at(-1)!.toFixed(2)} ms`);
}

function assertSameOrNextBlock(outcomes: TxOutcome[]) {
  for (const o of outcomes) expect(o.status, o.error).toBe("confirmed");
  const blocks = outcomes.map((o) => o.slotOrBlock!);
  console.log(`  landed in blocks: ${[...new Set(blocks)].join(", ")}`);
  expect(Math.max(...blocks) - Math.min(...blocks)).toBeLessThanOrEqual(1);
}

describe("router-evm-l2 e2e (local anvil)", () => {
  const rpcs: KeepAliveTransport[] = [];
  const mkRpc = (url: string) => { const t = new KeepAliveTransport({ url }); rpcs.push(t); return t; };
  afterAll(async () => { await Promise.all(rpcs.map((r) => r.close())); });

  beforeAll(async () => {
    // Sanity: the derived accounts are anvil's funded dev accounts.
    const funded = await mkRpc(BASE_RPC).request<string[]>("eth_accounts");
    expect(funded.slice(0, 10).map((a) => a.toLowerCase())).toEqual(accounts.map((a) => a.address.toLowerCase()));
  });

  it("Base: 10 wallets sent concurrently land in the same or next block", async () => {
    const router = new L2Router([{ chain: "base", rpcUrl: BASE_RPC }]);
    try {
      await router.warm();
      const batch = await signBatch(router, mkRpc(BASE_RPC), "base");
      const sent = await router.send(batch, {});
      report("base", sent.map((s) => router.sendStatFor(s.id)!));
      assertSameOrNextBlock(await router.confirm(sent, { timeoutMs: 20_000 }));
    } finally {
      await router.close();
    }
  });

  it("Base legacyFlashblocks: stub reports preconfirmed before confirmed", async () => {
    const anvil = mkRpc(BASE_RPC);
    // Flashblocks-style stub: a tx the sequencer holds (anvil pending pool) gets a
    // receipt for the pending block (head + 1) before the canonical block exists.
    const stub: StubRpc = await startStubRpc(async (method, params) => {
      if (method !== "eth_getTransactionReceipt") return anvil.request(method, params);
      const real = await anvil.request("eth_getTransactionReceipt", params);
      if (real) return real;
      const tx = await anvil.request<{ blockNumber: string | null } | null>("eth_getTransactionByHash", params);
      if (!tx || tx.blockNumber) return null;
      const head = BigInt(await anvil.request<string>("eth_blockNumber"));
      return { transactionHash: params[0], status: "0x1", blockNumber: `0x${(head + 1n).toString(16)}`, blockHash: null };
    });
    const router = new L2Router([{ chain: "base", rpcUrl: BASE_RPC }], { legacyFlashblocks: true, flashblocksRpcUrl: stub.url, pollIntervalMs: 25 });
    // Hold block production so the Flashblock window is observable deterministically.
    await anvil.request("evm_setIntervalMining", [0]);
    try {
      await router.warm();
      const batch = await signBatch(router, anvil, "base");
      const sent: SentTx[] = await router.send(batch, { priorityFee: "1000000" });
      report("base+flashblocks", sent.map((s) => router.sendStatFor(s.id)!));

      const history = new Map<string, string[]>();
      let preconfs = 0;
      let mined = false;
      const outcomes = await router.confirm(sent, {
        timeoutMs: 20_000,
        onUpdate: (o) => {
          history.set(o.sent.id, [...(history.get(o.sent.id) ?? []), o.status]);
          if (o.status === "preconfirmed" && ++preconfs === sent.length && !mined) {
            mined = true;
            void anvil.request("evm_mine", []);
          }
        },
      });
      for (const s of sent) expect(history.get(s.id)).toEqual(["preconfirmed", "confirmed"]);
      assertSameOrNextBlock(outcomes);
    } finally {
      await anvil.request("evm_setIntervalMining", [1]).catch(() => undefined);
      await router.close();
      await stub.close();
    }
  });

  it("Robinhood: 10 wallets sent concurrently land in the same or next block (FCFS, zero tip)", async () => {
    const router = new L2Router([{ chain: "robinhood", rpcUrl: RH_RPC }]);
    try {
      await router.warm();
      const batch = await signBatch(router, mkRpc(RH_RPC), "robinhood");
      const sent = await router.send(batch, {});
      report("robinhood", sent.map((s) => router.sendStatFor(s.id)!));
      assertSameOrNextBlock(await router.confirm(sent, { timeoutMs: 20_000 }));
    } finally {
      await router.close();
    }
  });

  it("Robinhood: detectTimeboost is false on anvil", async () => {
    expect(await detectTimeboost(RH_RPC)).toBe(false);
  });
});
