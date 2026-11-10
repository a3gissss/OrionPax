import { describe, expect, it } from "vitest";
import type { EngineEvent, JobView } from "@mint-engine/core";
import { initialJobsState, jobsReducer, type JobsState } from "../src/lib/store";
import { decodeTokenProtocol, encodeTokenProtocol } from "../src/lib/api";

const view: JobView = {
  job: {
    id: "j1", target: { kind: "nft", chain: "base", address: "0x" + "1".repeat(40), quantity: 1 },
    walletIds: ["w1"], fees: {}, trigger: { type: "now" }, maxRetries: 2, createdAt: 1,
  },
  status: "pending",
  outcomes: [],
};
const ev = (event: EngineEvent) => ({ type: "ws" as const, msg: { type: "event" as const, event } });
const tx = (status: "prepared" | "sent" | "failed" | "confirmed", at: number, extra: Partial<EngineEvent> = {}) =>
  ev({ type: "tx.status", jobId: "j1", walletId: "w1", status, at, ...extra } as EngineEvent);

describe("jobs reducer", () => {
  it("resets a wallet row when a retry starts after failure", () => {
    let s: JobsState = jobsReducer(initialJobsState, { type: "upsert", job: view });
    s = jobsReducer(s, tx("prepared", 10));
    s = jobsReducer(s, tx("sent", 20, { txId: "a" }));
    s = jobsReducer(s, tx("failed", 30, { error: "blockhash expired" }));
    s = jobsReducer(s, tx("prepared", 40));
    expect(s.timelines.j1!.w1).toMatchObject({ status: "prepared", attempt: 2, stages: { prepared: 40 } });
    expect(s.timelines.j1!.w1!.error).toBeUndefined();
    s = jobsReducer(s, tx("confirmed", 50, { txId: "b" }));
    expect(s.timelines.j1!.w1).toMatchObject({ status: "confirmed", txId: "b" });
  });

  it("does not roll back status when a stale REST view arrives after WS events", () => {
    let s = jobsReducer(initialJobsState, ev({ type: "job.status", jobId: "j1", status: "done", at: 5 }));
    s = jobsReducer(s, { type: "upsert", job: view });
    expect(s.jobs.j1!.status).toBe("done");
  });
});

describe("ws token protocol", () => {
  it("round-trips tokens with characters invalid in a subprotocol", () => {
    const token = "a/b+c= d✓";
    const p = encodeTokenProtocol(token);
    expect(p).toMatch(/^token\.[A-Za-z0-9_-]+$/);
    expect(decodeTokenProtocol(p)).toBe(token);
  });
});
