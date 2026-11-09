import { describe, expect, it } from "vitest";
import type { PreparedTx } from "@mint-engine/core";
import {
  hexToBytes,
  keccak256,
  parseTransaction,
  bytesToHex,
  serializeTransaction,
  toHex,
  recoverMessageAddress,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { EvmL1Router, NonceManager, feeStrategyFor, patchUnsignedTx, isNonceError } from "../src/index.js";

const gwei = 1_000_000_000n;

describe("feeStrategyFor", () => {
  it("uses 2 x baseFee + priority", () => {
    const f = feeStrategyFor({ baseFeePerGas: 10n * gwei }, { priorityFee: String(2n * gwei) });
    expect(f.maxFeePerGas).toBe(22n * gwei);
    expect(f.maxPriorityFeePerGas).toBe(2n * gwei);
    expect(f.capped).toBe(false);
  });
  it("defaults priority and handles missing baseFee", () => {
    const f = feeStrategyFor({ baseFeePerGas: null }, {});
    expect(f.maxFeePerGas).toBe(f.maxPriorityFeePerGas);
  });
  it("honors maxFee cap and clamps priority", () => {
    const f = feeStrategyFor({ baseFeePerGas: 10n * gwei }, { priorityFee: String(30n * gwei), maxFee: String(15n * gwei) });
    expect(f.maxFeePerGas).toBe(15n * gwei);
    expect(f.maxPriorityFeePerGas).toBe(15n * gwei);
    expect(f.capped).toBe(true);
    expect(f.belowBaseFee).toBe(false);
  });
  it("honors maxTotalFee / gas", () => {
    const f = feeStrategyFor({ baseFeePerGas: 10n * gwei }, { priorityFee: String(gwei), maxTotalFee: String(21000n * 5n * gwei) }, { gasLimit: 21000 });
    expect(f.maxFeePerGas).toBe(5n * gwei);
    expect(f.belowBaseFee).toBe(true);
  });
  it("refuses maxTotalFee without a gas limit", () => {
    expect(() => feeStrategyFor({ baseFeePerGas: 1n }, { maxTotalFee: "1000" })).toThrow(/gasLimit/);
  });
  it("rejects non-decimal strings", () => {
    expect(() => feeStrategyFor({ baseFeePerGas: 1n }, { priorityFee: "1.5" })).toThrow();
  });
});

describe("NonceManager", () => {
  const addr = "0x0000000000000000000000000000000000000001";
  it("seeds once, reserves sequentially, reuses released, resyncs", async () => {
    let chain = 5;
    let calls = 0;
    const nm = new NonceManager({ getTransactionCount: async () => (calls++, chain) });
    const got = await Promise.all([nm.reserve(addr), nm.reserve(addr), nm.reserve(addr)]);
    expect(got).toEqual([5, 6, 7]);
    expect(calls).toBe(1);
    await nm.release(addr, 6);
    expect(await nm.reserve(addr)).toBe(6);
    await nm.release(addr, 7);
    expect(nm.peek(addr)).toBe(7);
    expect(await nm.reserve(addr)).toBe(7);
    chain = 42;
    expect(await nm.resync(addr)).toBe(42);
    expect(await nm.reserve(addr)).toBe(42);
  });
  it("collapses released nonces at the tip", async () => {
    const nm = new NonceManager({ getTransactionCount: async () => 0 });
    for (let i = 0; i < 4; i++) await nm.reserve(addr);
    await nm.release(addr, 2);
    await nm.release(addr, 3);
    expect(nm.peek(addr)).toBe(2);
    expect(await nm.reserve(addr)).toBe(2);
    expect(await nm.reserve(addr)).toBe(3);
    expect(await nm.reserve(addr)).toBe(4);
  });
  it("ignores release of nonces below the chain floor", async () => {
    let chain = 0;
    const nm = new NonceManager({ getTransactionCount: async () => chain });
    const n = await nm.reserve(addr);
    chain = 7;
    await nm.resync(addr);
    await nm.release(addr, n);
    expect(await nm.reserve(addr)).toBe(7);
  });
  it("recognizes nonce errors", () => {
    expect(isNonceError(new Error("nonce too low: next nonce 3"))).toBe(true);
    expect(isNonceError(new Error("insufficient funds"))).toBe(false);
  });
});

describe("patchUnsignedTx", () => {
  it("patches nonce and fees, upgrading legacy to 1559", () => {
    const legacy = hexToBytes(
      serializeTransaction({ chainId: 1, nonce: 0, to: "0x0000000000000000000000000000000000000002", value: 1n, gas: 21000n, gasPrice: 7n }),
    );
    const out = patchUnsignedTx(legacy, { nonce: 9, maxFeePerGas: 100n, maxPriorityFeePerGas: 3n });
    const tx = parseTransaction(bytesToHex(out));
    expect(tx.type).toBe("eip1559");
    expect(tx.nonce).toBe(9);
    expect(tx.maxFeePerGas).toBe(100n);
    expect(tx.maxPriorityFeePerGas).toBe(3n);
    expect(tx.value).toBe(1n);
    expect(tx.gas).toBe(21000n);
    expect(tx.chainId).toBe(1);
  });
  it("clamps an existing tip above a lowered fee cap", () => {
    const u = hexToBytes(
      serializeTransaction({ type: "eip1559", chainId: 1, nonce: 0, to: "0x0000000000000000000000000000000000000002", gas: 21000n, maxFeePerGas: 50n, maxPriorityFeePerGas: 5n }),
    );
    const tx = parseTransaction(bytesToHex(patchUnsignedTx(u, { maxFeePerGas: 3n })));
    expect(tx.maxPriorityFeePerGas).toBe(3n);
  });
});

// ---------- router with fake transport ----------

const key = generatePrivateKey();
const acct = privateKeyToAccount(key);

async function signedTx(nonce: number) {
  const raw = await acct.signTransaction({
    chainId: 1, nonce, to: acct.address, value: 0n, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, type: "eip1559",
  });
  const prepared: PreparedTx = { chain: "ethereum", walletId: `w${nonce}`, unsigned: new Uint8Array(), value: "0", description: "t" };
  return { prepared, signed: hexToBytes(raw), hash: keccak256(raw) };
}

interface Call { url: string; method: string; params: unknown[]; headers: Record<string, string>; body: string }

function fakeFetch(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    const j = JSON.parse(body);
    const c: Call = { url, method: j.method, params: j.params, headers: init.headers as Record<string, string>, body };
    calls.push(c);
    let result: unknown;
    try {
      result = handler(c);
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -32000, message: (e as Error).message } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

function fakeClient(opts: { head: () => bigint; receipt: (h: string) => { status: "success" | "reverted"; blockNumber: bigint } | undefined }) {
  return {
    getBlockNumber: async () => opts.head(),
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = opts.receipt(hash);
      if (!r) throw new TransactionReceiptNotFoundError({ hash: hash as Hex });
      return r;
    },
    watchBlockNumber: ({ onBlockNumber, pollingInterval }: { onBlockNumber: (n: bigint) => void; pollingInterval: number }) => {
      onBlockNumber(opts.head());
      const t = setInterval(() => onBlockNumber(opts.head()), pollingInterval);
      return () => clearInterval(t);
    },
  } as unknown as PublicClient;
}

describe("EvmL1Router", () => {
  it("fans out public sends to every RPC and maps receipts", async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url.includes("bad")) throw new Error("boom");
      return keccak256(c.params[0] as Hex);
    });
    const a = await signedTx(0);
    const b = await signedTx(1);
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://a.local", extraRpcUrls: ["http://b.local", "http://bad.local"] },
      fetch: f,
      pollIntervalMs: 10,
      publicClient: fakeClient({
        head: () => 10n,
        receipt: (h) => (h === a.hash ? { status: "success", blockNumber: 10n } : { status: "reverted", blockNumber: 10n }),
      }),
    });
    const sent = await router.send([a, b], {});
    expect(calls.length).toBe(6);
    expect(sent[0]!.id).toBe(a.hash);
    expect(sent[0]!.via.sort()).toEqual(["rpc:a.local", "rpc:b.local"]);
    const out = await router.confirm(sent, { timeoutMs: 1000 });
    expect(out.map((o) => o.status)).toEqual(["confirmed", "failed"]);
    expect(out[1]!.error).toBe("reverted");
  });

  it("marks txs rejected everywhere as failed", async () => {
    const { f } = fakeFetch(() => {
      throw new Error("nonce too low");
    });
    const a = await signedTx(0);
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://a.local" },
      fetch: f,
      publicClient: fakeClient({ head: () => 1n, receipt: () => undefined }),
    });
    const sent = await router.send([a], {});
    expect(sent[0]!.via).toEqual([]);
    const [o] = await router.confirm(sent, { timeoutMs: 200 });
    expect(o!.status).toBe("failed");
    expect(isNonceError(o!.error)).toBe(true);
  });

  it("private: relay + signed bundles for N and N+1, never public RPC", async () => {
    const authKey = generatePrivateKey();
    const { f, calls } = fakeFetch((c) => (c.method === "eth_sendBundle" ? { bundleHash: "0x01" } : keccak256(c.params[0] as Hex)));
    const a = await signedTx(0);
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://public.local", privateRelayUrl: "http://relay.local" },
      bundle: { builderUrls: ["http://builder1.local", "http://builder2.local"], authKey },
      fetch: f,
      publicClient: fakeClient({ head: () => 100n, receipt: () => ({ status: "success", blockNumber: 101n }) }),
    });
    const sent = await router.send([a], { privateSubmission: true });
    expect(calls.some((c) => c.url.includes("public"))).toBe(false);
    const bundles = calls.filter((c) => c.method === "eth_sendBundle");
    expect(bundles.length).toBe(4);
    expect(bundles.map((c) => (c.params[0] as { blockNumber: string }).blockNumber).sort()).toEqual(
      [toHex(101n), toHex(101n), toHex(102n), toHex(102n)],
    );
    for (const c of bundles) {
      const [addr, sig] = c.headers["X-Flashbots-Signature"]!.split(":");
      const rec = await recoverMessageAddress({ message: keccak256(toHex(c.body)), signature: sig as Hex });
      expect(rec).toBe(addr);
      expect(addr).toBe(privateKeyToAccount(authKey).address);
      expect(addr).not.toBe(acct.address);
    }
    expect(sent[0]!.via.sort()).toEqual(["bundle:builder1.local", "bundle:builder2.local", "relay:relay.local"]);
    const [o] = await router.confirm(sent, { timeoutMs: 500 });
    expect(o!.status).toBe("confirmed");
  });

  it("bundle-only: expires once target blocks pass", async () => {
    let head = 100n;
    const { f } = fakeFetch(() => ({ bundleHash: "0x01" }));
    const a = await signedTx(0);
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://public.local" },
      bundle: { builderUrls: ["http://builder.local"], authKey: generatePrivateKey() },
      fetch: f,
      pollIntervalMs: 5,
      publicClient: fakeClient({ head: () => head++, receipt: () => undefined }),
    });
    const sent = await router.send([a], { privateSubmission: true });
    const [o] = await router.confirm(sent, { timeoutMs: 2000 });
    expect(o!.status).toBe("expired");
  });

  it("refuses private submission with nothing configured", async () => {
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://public.local" },
      publicClient: fakeClient({ head: () => 1n, receipt: () => undefined }),
    });
    await expect(router.send([await signedTx(0)], { privateSubmission: true })).rejects.toThrow(/privateSubmission/);
  });

  it("returns sent on timeout", async () => {
    const { f } = fakeFetch((c) => keccak256(c.params[0] as Hex));
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: "http://a.local" },
      fetch: f,
      publicClient: fakeClient({ head: () => 1n, receipt: () => undefined }),
    });
    const sent = await router.send([await signedTx(0)], {});
    const [o] = await router.confirm(sent, { timeoutMs: 50 });
    expect(o!.status).toBe("sent");
  });
});
