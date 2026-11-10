import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockAdapter, MockRouter, mockSigner, mockWallets } from "@mint-engine/core";
import type { CreateJobRequest, EngineEvent, PreparedTx, TxOutcome, WalletRef } from "@mint-engine/core";
import { Engine, EngineError, JsonFileLedgerStore, MemoryLedgerStore, checkFeeCap, estimateMaxTotalFee } from "../src/index.js";
import type { LedgerStore } from "../src/index.js";

function setup(opts: { n?: number; store?: LedgerStore; router?: MockRouter; adapter?: MockAdapter; wallets?: WalletRef[] } = {}) {
  const wallets = opts.wallets ?? [...mockWallets(opts.n ?? 10), ...mockWallets(2, "solana").map((w) => ({ ...w, id: `s${w.id}` }))];
  const byId = new Map(wallets.map((w) => [w.id, w]));
  const router = opts.router ?? new MockRouter(["base"]);
  const adapter = opts.adapter ?? new MockAdapter("base", "nft");
  const engine = new Engine({
    adapters: [adapter], routers: [router], store: opts.store,
    getSigner: (id) => { const w = byId.get(id); if (!w) throw new Error("unknown wallet"); return mockSigner(w); },
  });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  return { engine, router, adapter, events };
}

const req = (walletIds: string[], extra: Partial<CreateJobRequest> = {}): CreateJobRequest => ({
  target: { kind: "nft", chain: "base", address: "0xabc", quantity: 1 },
  walletIds, fees: {}, trigger: { type: "now" }, ...extra,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`);

describe("createJob validation", () => {
  const { engine } = setup();
  it("rejects 0, >10 and duplicate wallets", () => {
    expect(() => engine.createJob(req([]))).toThrow(EngineError);
    expect(() => engine.createJob(req([...ids(10), "w11"]))).toThrow(/1\.\.10/);
    expect(() => engine.createJob(req(["w1", "w1"]))).toThrow(/duplicate/);
  });
  it("rejects wallet family mismatch and unknown wallets", () => {
    expect(() => engine.createJob(req(["w1", "sw1"]))).toThrow(/solana/);
    expect(() => engine.createJob(req(["nope"]))).toThrow(/unknown wallet/);
  });
  it("rejects targets with no adapter or router", () => {
    expect(() => engine.createJob(req(["w1"], { target: { kind: "token", chain: "base", tokenAddress: "0x1", launchpadAddress: "0x2", spendPerWallet: "1", slippageBps: 50 } }))).toThrow(/no adapter/);
    const e2 = new Engine({ adapters: [new MockAdapter("base")], routers: [new MockRouter(["ethereum"])], getSigner: (id) => mockSigner(mockWallets(1)[0]!) });
    expect(() => e2.createJob(req(["w1"]))).toThrow(/no router/);
  });
  it("creates a pending job and emits job.created", () => {
    const { engine, events } = setup();
    const job = engine.createJob(req(ids(3)));
    expect(job.maxRetries).toBe(2);
    expect(engine.get(job.id)?.status).toBe("pending");
    expect(events.map((e) => e.type)).toEqual(["job.created", "job.status"]);
    expect(engine.list()).toHaveLength(1);
  });
});

describe("run", () => {
  it("confirms every wallet with a single batched send", async () => {
    const { engine, router, events } = setup();
    let sendCalls = 0;
    const orig = router.send.bind(router);
    router.send = async (s, f) => { sendCalls++; return orig(s, f); };
    const job = engine.createJob(req(ids(10)));
    const view = await engine.run(job.id);
    expect(view.status).toBe("done");
    expect(view.outcomes.filter((o) => o.status === "confirmed")).toHaveLength(10);
    expect(sendCalls).toBe(1);
    const tx = events.filter((e) => e.type === "tx.status");
    for (const s of ["prepared", "signed", "sent", "confirmed"]) expect(tx.filter((e) => e.status === s)).toHaveLength(10);
    // status order
    const st = events.filter((e) => e.type === "job.status").map((e) => (e as { status: string }).status);
    expect(st).toEqual(["pending", "waiting", "firing", "done"]);
  });

  it("runs beforeSign on every tx and signs what it returns", async () => {
    const wallets = mockWallets(3);
    const byId = new Map(wallets.map((w) => [w.id, w]));
    const signedBytes: string[] = [];
    const engine = new Engine({
      adapters: [new MockAdapter("base", "nft")], routers: [new MockRouter(["base"])],
      getSigner: (id) => ({ wallet: byId.get(id)!, async signTransaction(u) { signedBytes.push(new TextDecoder().decode(u)); return u; } }),
      beforeSign: async (tx, wallet) => ({ ...tx, nonce: 7, unsigned: new TextEncoder().encode(`patched:${wallet.id}`) }),
    });
    const view = await engine.run(engine.createJob(req(ids(3))).id);
    expect(view.status).toBe("done");
    expect(signedBytes.sort()).toEqual(["patched:w1", "patched:w2", "patched:w3"]);
  });

  it("retries only failed wallets, up to maxRetries", async () => {
    const { engine, router } = setup();
    router.failWallets.add("w3");
    const job = engine.createJob(req(ids(5), { maxRetries: 2 }));
    const view = await engine.run(job.id);
    expect(view.status).toBe("failed");
    const perWallet = (id: string) => router.sent.filter((s) => s.walletId === id).length;
    expect(perWallet("w3")).toBe(3);
    for (const id of ["w1", "w2", "w4", "w5"]) expect(perWallet(id)).toBe(1);
  });

  it("retry succeeds when the failure clears", async () => {
    const { engine, router } = setup();
    router.failWallets.add("w2");
    const orig = router.confirm.bind(router);
    router.confirm = async (s, o) => { const r = await orig(s, o); router.failWallets.clear(); return r; };
    const view = await engine.run(engine.createJob(req(ids(3))).id);
    expect(view.status).toBe("done");
    expect(router.sent.filter((s) => s.walletId === "w2")).toHaveLength(2);
  });

  it("never retries still-pending txs", async () => {
    const { engine, router } = setup();
    router.confirm = async (sent) => sent.map((s): TxOutcome => ({ sent: s, status: s.walletId === "w1" ? "sent" : "confirmed" }));
    const view = await engine.run(engine.createJob(req(ids(3))).id);
    expect(view.status).toBe("failed");
    expect(router.sent).toHaveLength(3);
    expect(view.outcomes.find((o) => o.sent.walletId === "w1")?.status).toBe("sent");
  });

  it("re-prepares expired pre-armed txs at fire time", async () => {
    const wallets = mockWallets(2);
    const adapter = new MockAdapter("base");
    let prepares = 0;
    const orig = adapter.prepare.bind(adapter);
    adapter.prepare = async (...a) => { prepares++; return orig(...a); };
    let t = 1_000_000;
    const engine = new Engine({
      adapters: [adapter], routers: [new MockRouter()], getSigner: (id) => mockSigner(wallets.find((w) => w.id === id)!),
      now: () => t, preparedTtlMs: { evm: 1000 },
      waitForGoLive: async () => { t += 5000; },
    });
    const view = await engine.run(engine.createJob(req(["w1", "w2"])).id);
    expect(view.status).toBe("done");
    expect(prepares).toBe(4);
  });

  it("rejects malformed fee strings at create time", () => {
    const { engine } = setup();
    expect(() => engine.createJob(req(["w1"], { fees: { maxTotalFee: "0.01" } }))).toThrow(/maxTotalFee/);
    expect(() => engine.createJob(req(["w1"], { fees: { maxFee: "1e15" } }))).toThrow(/maxFee/);
  });

  it("long time triggers do not fire early (setTimeout clamp)", async () => {
    const { engine, router } = setup();
    const job = engine.createJob(req(["w1"], { trigger: { type: "time", at: Date.now() + 30 * 86_400_000 } }));
    const p = engine.run(job.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(router.sent).toHaveLength(0);
    expect(engine.get(job.id)?.status).toBe("waiting");
    await engine.cancel(job.id);
    expect((await p).status).toBe("cancelled");
  });

  it("cancel during the final confirm still reports done when everything landed", async () => {
    const { engine, router } = setup();
    const job = engine.createJob(req(ids(2)));
    const orig = router.confirm.bind(router);
    router.confirm = async (s, o) => { void engine.cancel(job.id); return orig(s, o); };
    expect((await engine.run(job.id)).status).toBe("done");
  });

  it("a resumed job that already went live does not wait for go-live again", async () => {
    const store = new MemoryLedgerStore();
    const wallets = mockWallets(3);
    const mk = (router: MockRouter, wait: () => Promise<void>) => new Engine({
      adapters: [new MockAdapter()], routers: [router], store, retryDelayMs: 0,
      getSigner: (id) => mockSigner(wallets.find((w) => w.id === id)!), waitForGoLive: wait,
    });
    const r1 = new MockRouter();
    r1.failWallets.add("w2");
    const a = mk(r1, async () => {});
    const job = a.createJob(req(ids(3), { trigger: { type: "event" }, maxRetries: 0 }));
    expect((await a.run(job.id)).status).toBe("failed");
    // Give the restarted engine a budget for one more attempt by bumping maxRetries in the stored record.
    const rec = (await store.load(job.id))!;
    rec.job.maxRetries = 1;
    await store.save(rec);
    const r2 = new MockRouter();
    const b = mk(r2, () => new Promise(() => {})); // would hang forever if called
    const view = await b.run(job.id);
    expect(view.status).toBe("done");
    expect(r2.sent.map((s) => s.walletId)).toEqual(["w2"]);
  });

  it("enforces the fee cap before send", async () => {
    const adapter = new MockAdapter("base", "nft");
    const orig = adapter.prepare.bind(adapter);
    adapter.prepare = async (...a) => ({ ...(await orig(...a)), computeOrGas: 100_000 });
    const { engine, router } = setup({ adapter });
    const job = engine.createJob(req(ids(2), { fees: { maxFee: "1000", maxTotalFee: "1000" } }));
    const view = await engine.run(job.id);
    expect(router.sent).toHaveLength(0);
    expect(view.status).toBe("failed");
    expect(view.outcomes.every((o) => o.status === "failed" && /fee cap/.test(o.error ?? ""))).toBe(true);
    // under the cap -> sends
    const ok = engine.createJob(req(ids(2), { fees: { maxFee: "10", maxTotalFee: "1000000" } }));
    expect((await engine.run(ok.id)).status).toBe("done");
  });

  it("fails closed when the fee cannot be bounded", () => {
    const tx: PreparedTx = { chain: "base", walletId: "w1", unsigned: new Uint8Array(), value: "0", description: "" };
    expect(checkFeeCap(tx, { maxTotalFee: "1" }, undefined)).toMatch(/cannot be bounded/);
    expect(checkFeeCap(tx, {}, undefined)).toBeUndefined();
    expect(estimateMaxTotalFee({ ...tx, chain: "solana", computeOrGas: 200_000 }, { priorityFee: "1000000", jitoTip: "10" })).toBe(5000n + 200_000n + 10n);
  });

  it("refuses quantity above the per-wallet limit", async () => {
    const { engine, router } = setup();
    const job = engine.createJob(req(ids(2), { target: { kind: "nft", chain: "base", address: "0x1", quantity: 3 } }));
    const view = await engine.run(job.id);
    expect(view.status).toBe("failed");
    expect(router.sent).toHaveLength(0);
  });

  it("cancels while waiting for a time trigger", async () => {
    const { engine, router } = setup();
    const job = engine.createJob(req(ids(2), { trigger: { type: "time", at: Date.now() + 60_000 } }));
    const p = engine.run(job.id);
    await new Promise((r) => setTimeout(r, 20));
    const v = await engine.cancel(job.id);
    expect(v.status).toBe("cancelled");
    expect((await p).status).toBe("cancelled");
    expect(router.sent).toHaveLength(0);
  });

  it("unsupported triggers fail without the watcher", async () => {
    const { engine } = setup();
    const view = await engine.run(engine.createJob(req(["w1"], { trigger: { type: "event" } })).id);
    expect(view.status).toBe("failed");
  });
});

describe("idempotency", () => {
  it("crash mid-send: a fresh engine never resends", async () => {
    const store = new MemoryLedgerStore();
    const inner = new MockRouter();
    const crashing = new MockRouter();
    crashing.send = async (s, f) => { await inner.send(s, f); throw new Error("process crashed"); };
    const a = setup({ store, router: crashing });
    const job = a.engine.createJob(req(ids(10)));
    expect((await a.engine.run(job.id)).status).toBe("failed");
    expect(inner.sent).toHaveLength(10);

    const b = setup({ store, router: inner });
    const view = await b.engine.run(job.id); // loads from store
    expect(inner.sent).toHaveLength(10);
    expect(view.outcomes.every((o) => o.status === "sent")).toBe(true);
  });

  it("crash after send recorded: resume confirms without resending", async () => {
    const store = new MemoryLedgerStore();
    const inner = new MockRouter();
    const crashing = new MockRouter();
    crashing.send = (s, f) => inner.send(s, f);
    crashing.confirm = async () => { throw new Error("process crashed"); };
    const a = setup({ store, router: crashing });
    const job = a.engine.createJob(req(ids(4)));
    await a.engine.run(job.id);

    const b = setup({ store, router: inner });
    await b.engine.restore();
    expect(b.engine.get(job.id)).toBeDefined();
    const view = await b.engine.run(job.id);
    expect(view.status).toBe("done");
    expect(inner.sent).toHaveLength(4);
  });

  it("JSON file store round-trips and survives a new instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "engine-ledger-"));
    try {
      const path = join(dir, "ledger.json");
      const a = setup({ store: new JsonFileLedgerStore(path) });
      const job = a.engine.createJob(req(ids(3)));
      await a.engine.run(job.id);
      const store2 = new JsonFileLedgerStore(path);
      const rec = await store2.load(job.id);
      expect(rec?.status).toBe("done");
      expect(Object.values(rec!.wallets).every((w) => w.state === "confirmed" && w.sends === 1)).toBe(true);
      const b = setup({ store: store2 });
      expect((await b.engine.run(job.id)).status).toBe("done");
      expect(b.router.sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not send if the intent cannot be persisted", async () => {
    const store = new MemoryLedgerStore();
    const { engine, router } = setup({ store });
    const job = engine.createJob(req(ids(2)));
    const orig = store.save.bind(store);
    store.save = async (r) => {
      if (Object.values(r.wallets).some((w) => w.state === "sending")) throw new Error("disk full");
      return orig(r);
    };
    expect((await engine.run(job.id)).status).toBe("failed");
    expect(router.sent).toHaveLength(0);
  });

  it("concurrent run calls share one execution", async () => {
    const { engine, router } = setup();
    const job = engine.createJob(req(ids(3)));
    await Promise.all([engine.run(job.id), engine.run(job.id)]);
    expect(router.sent).toHaveLength(3);
    await engine.run(job.id);
    expect(router.sent).toHaveLength(3);
  });
});

