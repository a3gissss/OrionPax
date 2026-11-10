import { afterEach, describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import type { PreparedTx, TxOutcome } from "@mint-engine/core";
import {
  BASE_DEFAULT_PRIORITY_FEE, KeepAliveTransport, L2Router, NonceManager, RpcError,
  detectTimeboost, l2FeeStrategy, redactUrl, submitExpressLane,
} from "../src/index.js";
import { StubRpcError, methodNotFound, startStubRpc, type StubRpc } from "./stub-rpc.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});
async function stub(h: Parameters<typeof startStubRpc>[0]): Promise<StubRpc> {
  const s = await startStubRpc(h);
  cleanups.push(() => s.close());
  return s;
}
function track<T extends { close(): Promise<void> }>(x: T): T {
  cleanups.push(() => x.close());
  return x;
}

const hex = (n: number) => `0x${n.toString(16)}`;
function prepared(chain: "base" | "robinhood", walletId: string): PreparedTx {
  return { chain, walletId, unsigned: new Uint8Array(), value: "0", description: "test" };
}
function rawTx(i: number): Uint8Array {
  return new Uint8Array([0x02, 0xf8, i, 1, 2, 3]);
}

describe("l2FeeStrategy", () => {
  it("Base uses FeeStrategy.priorityFee, defaulting to a modest bump", () => {
    expect(l2FeeStrategy("base", {}, { baseFeePerGas: 1000n })).toEqual({
      maxPriorityFeePerGas: BASE_DEFAULT_PRIORITY_FEE,
      maxFeePerGas: 2000n + BASE_DEFAULT_PRIORITY_FEE,
    });
    expect(l2FeeStrategy("base", { priorityFee: "7" }, { baseFeePerGas: 10n })).toEqual({ maxPriorityFeePerGas: 7n, maxFeePerGas: 27n });
  });

  it("Robinhood pays a minimal tip (FCFS) regardless of priorityFee", () => {
    expect(l2FeeStrategy("robinhood", { priorityFee: "999999" }, { baseFeePerGas: 100n })).toEqual({ maxPriorityFeePerGas: 0n, maxFeePerGas: 200n });
  });

  it("respects maxFee and maxTotalFee caps", () => {
    expect(l2FeeStrategy("base", { priorityFee: "50", maxFee: "40" }, { baseFeePerGas: 10n })).toEqual({ maxPriorityFeePerGas: 40n, maxFeePerGas: 40n });
    expect(l2FeeStrategy("base", { priorityFee: "5", maxTotalFee: "21000" }, { baseFeePerGas: 10n, gas: 1000n }).maxFeePerGas).toBe(21n);
  });

  it("refuses caps it can't enforce or that can't be included", () => {
    expect(() => l2FeeStrategy("base", { maxTotalFee: "21000" }, { baseFeePerGas: 10n })).toThrow(/gas limit/);
    expect(() => l2FeeStrategy("base", { maxTotalFee: "21000" }, { baseFeePerGas: 100n, gas: 1000n })).toThrow(/below the current base fee/);
  });

  it("rejects malformed wei strings", () => {
    expect(() => l2FeeStrategy("base", { priorityFee: "1.5" }, { baseFeePerGas: 1n })).toThrow(/priorityFee/);
  });
});

describe("NonceManager", () => {
  it("hands out distinct nonces concurrently with a single RPC read", async () => {
    let reads = 0;
    const nm = new NonceManager({ request: async () => { reads++; return "0x5"; } } as never);
    const got = await Promise.all(Array.from({ length: 10 }, () => nm.next("0xAbC")));
    expect(got.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(reads).toBe(1);
    expect(await nm.next("0xabc")).toBe(15); // case-insensitive
    expect(await nm.reserve("0xabc", 3)).toBe(16);
    expect(await nm.peek("0xabc")).toBe(19);
    nm.reset("0xabc");
    expect(await nm.next("0xabc")).toBe(5);
    expect(reads).toBe(2);
  });

  it("set() during an in-flight read wins for every caller", async () => {
    let release!: (v: string) => void;
    const nm = new NonceManager({ request: () => new Promise<string>((r) => { release = r; }) } as never);
    const first = nm.next("0xa");
    nm.set("0xa", 7);
    release("0x5");
    expect(await first).toBe(7);
    expect(await nm.next("0xa")).toBe(8);
  });

  it("does not cache a failed read", async () => {
    let fail = true;
    const nm = new NonceManager({ request: async () => { if (fail) throw new Error("down"); return "0x1"; } } as never);
    await expect(nm.next("0x1")).rejects.toThrow("down");
    fail = false;
    expect(await nm.next("0x1")).toBe(1);
  });
});

describe("KeepAliveTransport", () => {
  it("does requests, batches and surfaces RPC errors", async () => {
    const s = await stub((m, p) => {
      if (m === "echo") return p[0];
      if (m === "boom") throw new StubRpcError(-32602, "bad params");
      return "0x1";
    });
    const t = track(new KeepAliveTransport({ url: s.url, connections: 2 }));
    await t.warm();
    expect(s.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
    expect(await t.request("echo", ["hi"])).toBe("hi");
    await expect(t.request("boom")).rejects.toMatchObject({ code: -32602, message: "bad params" });
    const res = await t.batch([{ method: "echo", params: [1] }, { method: "boom" }, { method: "echo", params: [3] }]);
    expect(res[0]).toEqual({ ok: true, result: 1 });
    expect(res[1]!.ok).toBe(false);
    expect(res[2]).toEqual({ ok: true, result: 3 });
    expect(t.viemTransport()).toBeTypeOf("function");
  });

  it("redacts RPC URLs down to the host", () => {
    expect(redactUrl("https://user:pw@base.example.com/v2/SECRETKEY?k=1")).toBe("base.example.com");
  });
});

describe("detectTimeboost", () => {
  it("is false when timeboost methods are unknown", async () => {
    const s = await stub((m) => { throw methodNotFound(m); });
    expect(await detectTimeboost(s.url)).toBe(false);
  });

  it("is false when every method gets the same generic error", async () => {
    const s = await stub(() => { throw new StubRpcError(-32602, "invalid request"); });
    expect(await detectTimeboost(s.url)).toBe(false);
  });

  it("is true when the node knows timeboost_sendExpressLaneTransaction", async () => {
    const s = await stub((m) => {
      if (m === "timeboost_sendExpressLaneTransaction") throw new StubRpcError(-32602, "missing value for required argument 0");
      throw methodNotFound(m);
    });
    expect(await detectTimeboost(s.url)).toBe(true);
  });

  it("is false behind a permissive proxy that answers every method", async () => {
    const s = await stub(() => null);
    expect(await detectTimeboost(s.url)).toBe(false);
  });

  it("is false when the RPC is unreachable", async () => {
    expect(await detectTimeboost("http://127.0.0.1:1", { timeoutMs: 500 })).toBe(false);
  });

  it("express-lane submit refuses unless enabled", async () => {
    const rpc = { request: async () => null };
    await expect(submitExpressLane(rpc, { enabled: false, buildSubmission: async () => undefined }, "0x00")).rejects.toThrow(/disabled/);
    expect(await submitExpressLane(rpc, { enabled: true, buildSubmission: async () => undefined }, "0x00")).toBe(false);
  });
});

describe("L2Router.send", () => {
  it("rejects non-L2 chains and unknown chains", async () => {
    expect(() => new L2Router([{ chain: "ethereum", rpcUrl: "http://127.0.0.1:1" }])).toThrow(/does not handle/);
    const r = new L2Router([{ chain: "base", rpcUrl: "http://127.0.0.1:1" }]);
    await expect(r.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {})).rejects.toThrow(/no config/);
    await r.close();
  });

  it("fans every tx out to primary + extras and records latency", async () => {
    const primary = await stub((m, p) => (m === "eth_sendRawTransaction" ? keccak256(p[0] as `0x${string}`) : null));
    const extra = await stub((m) => { if (m === "eth_sendRawTransaction") throw new Error("already known"); return null; });
    const stats: unknown[] = [];
    const r = track(new L2Router([{ chain: "base", rpcUrl: primary.url, extraRpcUrls: [extra.url] }], { onSendStat: (s) => stats.push(s) }));
    await r.warm();
    const txs = Array.from({ length: 5 }, (_, i) => ({ prepared: prepared("base", `w${i}`), signed: rawTx(i) }));
    const sent = await r.send(txs, {});
    expect(sent).toHaveLength(5);
    await r.settled();
    sent.forEach((s, i) => {
      expect(s.id).toBe(keccak256(rawTx(i)));
      expect(s.via.length).toBeGreaterThanOrEqual(1);
      const stat = r.sendStatFor(s.id)!;
      expect(stat.latencyMs).toBeGreaterThanOrEqual(0);
      expect(stat.attempts.map((a) => a.endpoint).sort()).toEqual([new URL(primary.url).host, new URL(extra.url).host].sort());
      expect(stat.attempts.every((a) => a.ok)).toBe(true); // "already known" counts as accepted
    });
    expect(stats).toHaveLength(5);
    expect(primary.calls.filter((c) => c.method === "eth_sendRawTransaction")).toHaveLength(5);
    expect(extra.calls.filter((c) => c.method === "eth_sendRawTransaction")).toHaveLength(5);
  });

  it("a slow extra endpoint doesn't delay send", async () => {
    const primary = await stub(() => null);
    const slow = await stub(async () => { await new Promise((r) => setTimeout(r, 1500)); return null; });
    const r = track(new L2Router([{ chain: "base", rpcUrl: primary.url, extraRpcUrls: [slow.url] }]));
    await r.warm(); // the slow stub answers warm-up slowly too; that's fine
    const t0 = performance.now();
    const [sent] = await r.send([{ prepared: prepared("base", "w1"), signed: rawTx(1) }], {});
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(sent!.via).toEqual([new URL(primary.url).host]);
    await r.settled();
    expect(r.sendStatFor(sent!.id)!.attempts).toHaveLength(2);
  });

  it("an ambiguous send (timeout) is still polled instead of failed", async () => {
    let receipts = false;
    const s = await stub(async (m) => {
      // Reply far later than the client timeout (undici timers are coarse, ~0.5-1 s).
      if (m === "eth_sendRawTransaction") { await new Promise((r) => setTimeout(r, 3000)); receipts = true; return null; }
      if (m === "eth_blockNumber") return "0x5";
      if (m === "eth_getTransactionReceipt") return receipts ? { status: "0x1", blockNumber: "0x5" } : null;
      return null;
    });
    const r = track(new L2Router([{ chain: "robinhood", rpcUrl: s.url }], { pollIntervalMs: 10, transport: { timeoutMs: 300 } }));
    const [sent] = await r.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {});
    expect(sent!.via).toEqual([]);
    const [out] = await r.confirm([sent!], { timeoutMs: 8000 });
    expect(out!.status).toBe("confirmed");
  }, 15_000);

  it("a tx no endpoint accepts comes back with empty via and fails in confirm", async () => {
    const s = await stub((m) => { if (m === "eth_sendRawTransaction") throw new Error("nonce too low"); return "0x1"; });
    const r = track(new L2Router([{ chain: "robinhood", rpcUrl: s.url }]));
    const [sent] = await r.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {});
    expect(sent!.via).toEqual([]);
    expect(r.sendStatFor(sent!.id)?.latencyMs).toBeUndefined();
    const [out] = await r.confirm([sent!], { timeoutMs: 1000 });
    expect(out!.status).toBe("failed");
    expect(out!.error).toMatch(/nonce too low/);
  });
});

describe("L2Router.confirm", () => {
  /** Chain stub: tx seen at `seenAt` poll as a Flashblock receipt (block head+1), canonical once head advances. */
  function chainStub(opts: { revert?: boolean; neverSeen?: boolean } = {}) {
    let head = 100;
    let polls = 0;
    const handler = (m: string) => {
      if (m === "eth_sendRawTransaction") return null;
      if (m === "eth_blockNumber") {
        polls++;
        if (polls === 4) head = 101;
        return hex(head);
      }
      if (m === "eth_getTransactionReceipt") {
        if (opts.neverSeen || polls < 2) return null;
        return { status: opts.revert ? "0x0" : "0x1", blockNumber: hex(101) };
      }
      return null;
    };
    return handler;
  }

  it("Base (default, post-Denim): a receipt is the confirmation, no preconf step", async () => {
    const s = await stub(chainStub());
    const seen: TxOutcome[] = [];
    const r = track(new L2Router([{ chain: "base", rpcUrl: s.url }], { pollIntervalMs: 5 }));
    const sent = await r.send([{ prepared: prepared("base", "w1"), signed: rawTx(1) }], {});
    const [out] = await r.confirm(sent, { timeoutMs: 5000, acceptPreconf: true, onUpdate: (o) => seen.push(o) });
    expect(seen.map((o) => o.status)).toEqual(["confirmed"]);
    expect(out).toMatchObject({ status: "confirmed", slotOrBlock: 101 });
  });

  it("Base legacyFlashblocks: preconfirmed (Flashblock) before confirmed (canonical)", async () => {
    const s = await stub(chainStub());
    const seen: TxOutcome[] = [];
    const r = track(new L2Router([{ chain: "base", rpcUrl: s.url }], { pollIntervalMs: 5, legacyFlashblocks: true }));
    const sent = await r.send([{ prepared: prepared("base", "w1"), signed: rawTx(1) }], {});
    const [out] = await r.confirm(sent, { timeoutMs: 5000, onUpdate: (o) => seen.push(o) });
    expect(seen.map((o) => o.status)).toEqual(["preconfirmed", "confirmed"]);
    expect(out).toMatchObject({ status: "confirmed", slotOrBlock: 101 });
  });

  it("Base legacyFlashblocks: acceptPreconf resolves at the Flashblock", async () => {
    const s = await stub(chainStub());
    const r = track(new L2Router([{ chain: "base", rpcUrl: s.url }], { pollIntervalMs: 5, legacyFlashblocks: true }));
    const sent = await r.send([{ prepared: prepared("base", "w1"), signed: rawTx(1) }], {});
    const [out] = await r.confirm(sent, { timeoutMs: 5000, acceptPreconf: true });
    expect(out!.status).toBe("preconfirmed");
  });

  it("Base legacyFlashblocks: detects preconf via a separate Flashblocks RPC's pending block", async () => {
    const canon = await stub((m) => (m === "eth_blockNumber" ? "0x10" : null));
    const fb = await stub((m) => (m === "eth_getBlockByNumber" ? { number: "0x11", transactions: [keccak256(rawTx(1))] } : null));
    const r = track(new L2Router([{ chain: "base", rpcUrl: canon.url }], { pollIntervalMs: 5, legacyFlashblocks: true, flashblocksRpcUrl: fb.url }));
    const sent = await r.send([{ prepared: prepared("base", "w1"), signed: rawTx(1) }], {});
    const [out] = await r.confirm(sent, { timeoutMs: 5000, acceptPreconf: true });
    expect(out).toMatchObject({ status: "preconfirmed", slotOrBlock: 0x11 });
  });

  it("Robinhood: receipt means confirmed; reverts fail; timeouts keep last status", async () => {
    const ok = await stub(chainStub());
    const r1 = track(new L2Router([{ chain: "robinhood", rpcUrl: ok.url }], { pollIntervalMs: 5 }));
    const [o1] = await r1.confirm(await r1.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {}), { timeoutMs: 5000 });
    expect(o1!.status).toBe("confirmed");

    const bad = await stub(chainStub({ revert: true }));
    const r2 = track(new L2Router([{ chain: "robinhood", rpcUrl: bad.url }], { pollIntervalMs: 5 }));
    const [o2] = await r2.confirm(await r2.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {}), { timeoutMs: 5000 });
    expect(o2).toMatchObject({ status: "failed", error: "reverted" });

    const never = await stub(chainStub({ neverSeen: true }));
    const r3 = track(new L2Router([{ chain: "robinhood", rpcUrl: never.url }], { pollIntervalMs: 5 }));
    const [o3] = await r3.confirm(await r3.send([{ prepared: prepared("robinhood", "w1"), signed: rawTx(1) }], {}), { timeoutMs: 100 });
    expect(o3!.status).toBe("sent");
    expect(o3!.error).toMatch(/timeout/);
  });
});

it("RpcError carries the JSON-RPC code", () => {
  expect(new RpcError("x", -32601).code).toBe(-32601);
});
