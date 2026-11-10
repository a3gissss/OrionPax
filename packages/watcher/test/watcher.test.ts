import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAdapter, type EngineEvent, type MintTarget } from "@mint-engine/core";
import { Watcher, jitteredBackoff, prearm, waitForGoLive } from "../src/index.js";

const target: MintTarget = { kind: "nft", chain: "base", address: "0x0000000000000000000000000000000000000001", quantity: 1 };

afterEach(() => {
  vi.useRealTimers();
});

describe("time trigger (real timers)", () => {
  it("fires within ±20 ms of the target and arms before firing", async () => {
    // Warm up JIT / module init so the measured run reflects steady-state scheduling.
    await waitForGoLive({ type: "time", at: Date.now() + 60 });
    // Timing on a shared, loaded machine can be disturbed by other processes; allow a few
    // attempts for the ±20 ms bound, but every attempt must arm first and never fire early.
    const errors: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const order: string[] = [];
      const at = Date.now() + 300;
      const res = await waitForGoLive({ type: "time", at }, {}, {
        leadMs: 150,
        onArm: () => { order.push("arm"); },
        onFire: () => { order.push("fire"); },
      });
      const wall = Date.now();
      expect(order).toEqual(["arm", "fire"]);
      expect(res.latenessMs!).toBeGreaterThanOrEqual(0); // never early
      expect(wall).toBeGreaterThanOrEqual(at);
      expect(res.armedAt!).toBeLessThan(res.firedAt);
      expect(res.armedAt!).toBeGreaterThanOrEqual(at - 150 - 1); // armed at t0 - leadMs, not earlier
      errors.push(Math.max(res.latenessMs!, wall - at));
      if (errors.at(-1)! <= 20) break;
    }
    expect(Math.min(...errors)).toBeLessThanOrEqual(20);
  });

  it("prearm helper runs onArm then onFire", async () => {
    const order: string[] = [];
    const t0 = Date.now() + 120;
    const res = await prearm(t0, { onArm: () => { order.push("arm"); }, onFire: () => { order.push("fire"); } }, { leadMs: 60 });
    expect(order).toEqual(["arm", "fire"]);
    expect(res.latenessMs!).toBeGreaterThanOrEqual(0);
  });
});

describe("time trigger (fake timers)", () => {
  it("corrects clock skew using chain time", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const skew = 5_000; // chain clock is 5 s ahead of local
    const at = Date.now() + skew + 10_000; // chain-time go-live in 10 s
    const deps = { now: () => Date.now(), getChainTime: async () => Date.now() + skew };
    let fired = false;
    const p = waitForGoLive({ type: "time", at }, deps, { leadMs: 1000, resyncBeforeMs: 2000 }).then((r) => { fired = true; return r; });
    await vi.advanceTimersByTimeAsync(9_990);
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const r = await p;
    expect(r.clockOffsetMs).toBe(skew);
    expect(r.scheduledAt).toBe(at - skew);
    expect(r.firedAt).toBeGreaterThanOrEqual(at - skew);
  });

  it("survives getChainTime failures with a warning", async () => {
    vi.useFakeTimers({ now: 0 });
    const events: EngineEvent[] = [];
    const p = waitForGoLive({ type: "time", at: 1000 }, {
      now: () => Date.now(), jobId: "j", emit: (e) => events.push(e),
      getChainTime: async () => { throw new Error("rpc down"); },
    });
    await vi.advanceTimersByTimeAsync(1001);
    const r = await p;
    expect(r.clockOffsetMs).toBe(0);
    expect(events.some((e) => e.type === "log" && e.level === "warn" && e.message.includes("rpc down"))).toBe(true);
  });

  it("arms immediately (late) when already past t0 - leadMs", async () => {
    vi.useFakeTimers({ now: 0 });
    const onArm = vi.fn();
    const p = waitForGoLive({ type: "time", at: 100 }, { now: () => Date.now() }, { leadMs: 5000, onArm });
    await vi.advanceTimersByTimeAsync(0);
    expect(onArm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    await p;
    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it("waits for a slow async onArm before onFire", async () => {
    vi.useFakeTimers({ now: 0 });
    const order: string[] = [];
    const p = waitForGoLive({ type: "time", at: 100 }, { now: () => Date.now() }, {
      leadMs: 50,
      onArm: () => new Promise<void>((r) => setTimeout(() => { order.push("arm-done"); r(); }, 200)),
      onFire: () => { order.push("fire"); },
    });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(order).toEqual(["arm-done", "fire"]);
  });

  it("fails fast when onArm rejects", async () => {
    vi.useFakeTimers({ now: 0 });
    const events: EngineEvent[] = [];
    const onFire = vi.fn();
    const p = waitForGoLive({ type: "state-poll", intervalMs: 100 }, {
      adapter: new MockAdapter("base", "nft", { live: false }), target, emit: (e) => events.push(e),
    }, { onArm: async () => { throw new Error("vault locked"); }, onFire });
    const assertion = expect(p).rejects.toThrow("vault locked");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(onFire).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "log" && e.level === "error" && e.message.includes("vault locked"))).toBe(true);
  });

  it("logs onArm failure but still fires when awaitArm=false", async () => {
    const events: EngineEvent[] = [];
    const onFire = vi.fn();
    await waitForGoLive({ type: "now" }, { emit: (e) => events.push(e) }, {
      awaitArm: false, onArm: async () => { throw new Error("boom"); }, onFire,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onFire).toHaveBeenCalled();
    expect(events.some((e) => e.type === "log" && e.level === "error" && e.message.includes("boom"))).toBe(true);
  });

  it("is cancellable", async () => {
    vi.useFakeTimers({ now: 0 });
    const ac = new AbortController();
    const onFire = vi.fn();
    const p = waitForGoLive({ type: "time", at: 10_000 }, { now: () => Date.now() }, { signal: ac.signal, onFire });
    const assertion = expect(p).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("now trigger", () => {
  it("fires immediately with arm first", async () => {
    const order: string[] = [];
    const r = await waitForGoLive({ type: "now" }, {}, { onArm: () => { order.push("arm"); }, onFire: () => { order.push("fire"); } });
    expect(r.trigger).toBe("now");
    expect(order).toEqual(["arm", "fire"]);
  });

  it("rejects when signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitForGoLive({ type: "now" }, {}, { signal: ac.signal })).rejects.toThrow();
  });
});

describe("state-poll trigger", () => {
  it("polls until live and emits mint.state on change", async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = new MockAdapter("base", "nft", { live: false });
    const detect = vi.spyOn(adapter, "detect");
    const events: EngineEvent[] = [];
    const p = waitForGoLive({ type: "state-poll", intervalMs: 100 }, { adapter, target, jobId: "j1", emit: (e) => events.push(e) });
    await vi.advanceTimersByTimeAsync(350);
    expect(detect).toHaveBeenCalledTimes(4);
    adapter.state = { live: true, pricePerUnit: "1" };
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(r.state?.live).toBe(true);
    const states = events.filter((e) => e.type === "mint.state");
    expect(states).toHaveLength(2); // not-live once (deduped), then live
  });

  it("backs off with jitter on RPC errors then recovers", async () => {
    vi.useFakeTimers({ now: 0 });
    let calls = 0;
    const adapter = { detect: vi.fn(async () => { calls++; if (calls <= 3) throw new Error("429"); return { live: true }; }) };
    const events: EngineEvent[] = [];
    const p = waitForGoLive({ type: "state-poll", intervalMs: 100 }, { adapter, target, emit: (e) => events.push(e), random: () => 0.5 });
    // backoffs with random=0.5 → exact exponential: 100, 200, 400
    await vi.advanceTimersByTimeAsync(299);
    expect(adapter.detect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(401);
    expect(adapter.detect).toHaveBeenCalledTimes(4);
    await p;
    expect(events.filter((e) => e.type === "log" && e.level === "warn")).toHaveLength(3);
  });

  it("requires adapter and target", async () => {
    await expect(waitForGoLive({ type: "state-poll", intervalMs: 10 }, {})).rejects.toThrow(/adapter/);
  });

  it("jitteredBackoff stays within bounds", () => {
    for (let a = 1; a < 10; a++) {
      const d = jitteredBackoff(100, a, 1000);
      expect(d).toBeGreaterThanOrEqual(Math.min(1000, 100 * 2 ** (a - 1)) * 0.5);
      expect(d).toBeLessThanOrEqual(Math.min(1000, 100 * 2 ** (a - 1) * 1.5));
    }
    expect(jitteredBackoff(100, 50, 1000, () => 0.99)).toBe(1000);
  });
});

describe("event trigger", () => {
  it("fires on subscription callback and unsubscribes", async () => {
    let cb: ((p?: unknown) => void) | undefined;
    const unsub = vi.fn();
    const p = waitForGoLive({ type: "event", signature: "SaleStarted()" }, {
      subscribe: (c, ctx) => { expect(ctx.signature).toBe("SaleStarted()"); cb = c; return unsub; },
    });
    await new Promise((r) => setTimeout(r, 5));
    cb!({ log: 1 });
    const r = await p;
    expect(r.event).toEqual({ log: 1 });
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("fires immediately if already live after subscribing", async () => {
    const adapter = new MockAdapter("base", "nft", { live: true });
    const unsub = vi.fn();
    const r = await waitForGoLive({ type: "event" }, { adapter, target, subscribe: async () => unsub });
    expect(r.state?.live).toBe(true);
    expect(unsub).toHaveBeenCalled();
  });

  it("verifyEvent ignores events while not live", async () => {
    const adapter = new MockAdapter("base", "nft", { live: false });
    let cb: ((p?: unknown) => void) | undefined;
    const p = waitForGoLive({ type: "event" }, { adapter, target, subscribe: (c) => { cb = c; return () => {}; } }, { verifyEvent: true, verifyWindowMs: 0 });
    let done = false;
    void p.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 5));
    cb!("early");
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    adapter.state = { live: true };
    cb!("real");
    const r = await p;
    expect(r.event).toBe("real");
  });

  it("verifyEvent keeps re-checking a lagging RPC after the event", async () => {
    vi.useFakeTimers({ now: 0 });
    let reads = 0;
    const adapter = { detect: vi.fn(async () => ({ live: ++reads >= 4 })) }; // initial check + 2 stale reads
    let cb: ((p?: unknown) => void) | undefined;
    const p = waitForGoLive({ type: "event" }, { adapter, target, now: () => Date.now(), subscribe: (c) => { cb = c; return () => {}; } }, { verifyEvent: true });
    await vi.advanceTimersByTimeAsync(0);
    cb!("SaleStarted");
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.event).toBe("SaleStarted");
    expect(r.state?.live).toBe(true);
  });

  it("releases a subscription that resolves after the watch was cancelled", async () => {
    vi.useFakeTimers({ now: 0 });
    const ac = new AbortController();
    const unsub = vi.fn();
    const p = waitForGoLive({ type: "event" }, {
      subscribe: () => new Promise((r) => setTimeout(() => r(unsub), 30_000)),
    }, { signal: ac.signal });
    const assertion = expect(p).rejects.toThrow();
    ac.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("cancels and unsubscribes on abort", async () => {
    const ac = new AbortController();
    const unsub = vi.fn();
    const p = waitForGoLive({ type: "event" }, { subscribe: () => unsub }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("propagates subscribe errors", async () => {
    await expect(waitForGoLive({ type: "event" }, { subscribe: () => { throw new Error("ws refused"); } })).rejects.toThrow("ws refused");
  });
});

describe("slot-or-block trigger", () => {
  it("polls getHeight and arms at at - leadBlocks", async () => {
    vi.useFakeTimers({ now: 0 });
    let h = 10;
    const order: string[] = [];
    const p = waitForGoLive({ type: "slot-or-block", at: 13 }, { getHeight: async () => h }, {
      heightPollMs: 100, leadBlocks: 1,
      onArm: (i) => { order.push(`arm@${h}`); expect(i.expectedHeight).toBe(13); },
      onFire: () => { order.push(`fire@${h}`); },
    });
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(100); h++; }
    await vi.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(r.height).toBe(13);
    expect(order).toEqual(["arm@12", "fire@13"]);
  });

  it("uses subscribeHeight when provided", async () => {
    let cb: ((h: number) => void) | undefined;
    const unsub = vi.fn();
    const p = waitForGoLive({ type: "slot-or-block", at: 5 }, {
      subscribeHeight: (c) => { cb = c; return unsub; },
      getHeight: async () => 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    cb!(4);
    cb!(6);
    const r = await p;
    expect(r.height).toBe(6);
    expect(unsub).toHaveBeenCalled();
  });

  it("falls back to polling getHeight when the push feed stalls", async () => {
    vi.useFakeTimers({ now: 0 });
    let h = 1;
    const p = waitForGoLive({ type: "slot-or-block", at: 3 }, {
      subscribeHeight: () => () => {}, // never pushes anything
      getHeight: async () => h,
    }, { heightFallbackPollMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    h = 3;
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(r.height).toBe(3);
  });

  it("requires a height source", async () => {
    await expect(waitForGoLive({ type: "slot-or-block", at: 1 }, {})).rejects.toThrow(/getHeight/);
  });
});

describe("Watcher class", () => {
  it("tracks, cancels and shares deps", async () => {
    vi.useFakeTimers({ now: 0 });
    const w = new Watcher({ now: () => Date.now() });
    const a = w.watch({ type: "time", at: 1000 });
    const b = w.watch({ type: "time", at: 5000 });
    expect(w.active).toBe(2);
    const bRes = expect(b.result).rejects.toThrow(/cancel/i);
    b.cancel();
    await bRes;
    await vi.advanceTimersByTimeAsync(1001);
    const r = await a.result;
    expect(r.trigger).toBe("time");
    expect(w.active).toBe(0);
  });

  it("cancelAll aborts every watch", async () => {
    const w = new Watcher({ subscribe: () => () => {} });
    const hs = [w.watch({ type: "event" }), w.watch({ type: "event" })];
    const all = Promise.allSettled(hs.map((h) => h.result));
    w.cancelAll();
    const settled = await all;
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
  });
});
