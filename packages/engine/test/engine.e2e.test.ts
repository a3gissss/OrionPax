// End-to-end with core mocks: 10-wallet job, retry isolation, crash recovery.
import { describe, expect, it } from "vitest";
import { MockAdapter, MockRouter, mockSigner, mockWallets } from "@mint-engine/core";
import type { CreateJobRequest, EngineEvent, TxRouter } from "@mint-engine/core";
import { Engine, MemoryLedgerStore } from "../src/index.js";
import type { LedgerStore } from "../src/index.js";

const ids = Array.from({ length: 10 }, (_, i) => `w${i + 1}`);
const request = (extra: Partial<CreateJobRequest> = {}): CreateJobRequest => ({
  target: { kind: "nft", chain: "base", address: "0x00000000000000000000000000000000000000aa", quantity: 1 },
  walletIds: ids, fees: {}, trigger: { type: "now" }, maxRetries: 2, ...extra,
});

function mockEngine(router: TxRouter, store?: LedgerStore) {
  const wallets = new Map(mockWallets(10).map((w) => [w.id, w]));
  const engine = new Engine({
    adapters: [new MockAdapter("base", "nft")], routers: [router], store,
    getSigner: (id) => mockSigner(wallets.get(id)!),
  });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  return { engine, events };
}

describe("engine e2e (mocks)", () => {
  it("10 wallets: all confirmed with the expected event sequence", async () => {
    const router = new MockRouter(["base"]);
    const { engine, events } = mockEngine(router);
    const job = engine.createJob(request());
    const view = await engine.run(job.id);

    expect(view.status).toBe("done");
    expect(view.outcomes).toHaveLength(10);
    expect(view.outcomes.every((o) => o.status === "confirmed")).toBe(true);
    expect(router.sent).toHaveLength(10);

    // Phase order: created → pending → waiting → mint.state → prepared/signed (pre-arm) → firing → sent → confirmed → done
    const phases = events.map((e) => (e.type === "job.status" ? `job:${e.status}` : e.type === "tx.status" ? `tx:${e.status}` : e.type))
      .filter((p) => p !== "log");
    const collapsed = phases.filter((p, i) => p !== phases[i - 1]);
    expect(collapsed).toEqual([
      "job.created", "job:pending", "job:waiting", "mint.state",
      ...collapsed.slice(4, collapsed.indexOf("job:firing")), // prepared/signed interleave per wallet
      "job:firing", "tx:sent", "tx:confirmed", "job:done",
    ]);
    const prearm = collapsed.slice(4, collapsed.indexOf("job:firing"));
    expect(new Set(prearm)).toEqual(new Set(["tx:prepared", "tx:signed"]));
    for (const id of ids) {
      const seq = events.filter((e) => e.type === "tx.status" && e.walletId === id).map((e) => (e as { status: string }).status);
      expect(seq).toEqual(["prepared", "signed", "sent", "confirmed"]);
    }
  });

  it("w3 fails: only w3 retries", async () => {
    const router = new MockRouter(["base"]);
    router.failWallets.add("w3");
    const { engine, events } = mockEngine(router);
    const view = await engine.run(engine.createJob(request({ maxRetries: 2 })).id);

    const sendsPer = (id: string) => router.sent.filter((s) => s.walletId === id).length;
    expect(sendsPer("w3")).toBe(3); // 1 + maxRetries
    for (const id of ids.filter((x) => x !== "w3")) expect(sendsPer(id)).toBe(1);
    expect(view.outcomes.filter((o) => o.status === "confirmed")).toHaveLength(9);
    expect(view.outcomes.find((o) => o.sent.walletId === "w3")?.status).toBe("failed");
    const w3Failed = events.filter((e) => e.type === "tx.status" && e.walletId === "w3" && e.status === "failed");
    expect(w3Failed).toHaveLength(3);
  });

  it("crash mid-send: a new Engine on the same ledger never sends a wallet twice", async () => {
    const store = new MemoryLedgerStore();
    const chain = new MockRouter(["base"]); // the "real" network: records every broadcast
    const crashing: TxRouter = {
      chains: ["base"],
      async send(s, f) { await chain.send(s, f); throw new Error("simulated crash after send"); },
      confirm: (s, o) => chain.confirm(s, o),
    };
    const first = mockEngine(crashing, store);
    const job = first.engine.createJob(request());
    await first.engine.run(job.id);
    expect(chain.sent).toHaveLength(10);

    const second = mockEngine(chain, store);
    await second.engine.restore();
    await second.engine.run(job.id);
    const counts = new Map<string, number>();
    for (const s of chain.sent) counts.set(s.walletId, (counts.get(s.walletId) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect(chain.sent).toHaveLength(10);
  });

  it("crash during confirm: restart confirms the recorded txs without resending", async () => {
    const store = new MemoryLedgerStore();
    const chain = new MockRouter(["base"]);
    const crashing: TxRouter = {
      chains: ["base"], send: (s, f) => chain.send(s, f),
      async confirm() { throw new Error("simulated crash during confirm"); },
    };
    const first = mockEngine(crashing, store);
    const job = first.engine.createJob(request());
    await first.engine.run(job.id);

    const second = mockEngine(chain, store);
    const view = await second.engine.run(job.id);
    expect(view.status).toBe("done");
    expect(chain.sent).toHaveLength(10);
  });
});
