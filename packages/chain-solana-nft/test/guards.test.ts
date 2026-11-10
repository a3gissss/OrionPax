import { describe, expect, it } from "vitest";
import { none, publicKey, sol, some } from "@metaplex-foundation/umi";
import { computeUnitLimit, parsePriorityFee, priorityFeeLamports, summarizeGuards } from "../src/guards.js";

const DEST = publicKey("11111111111111111111111111111111");

describe("summarizeGuards", () => {
  it("reads startDate, solPayment and mintLimit; ignores none()", () => {
    const s = summarizeGuards({
      startDate: some({ date: 1_700_000_000n }),
      endDate: none(),
      solPayment: some({ lamports: sol(1.5), destination: DEST }),
      mintLimit: some({ id: 3, limit: 2 }),
      botTax: some({ lamports: sol(0.01), lastInstruction: true }),
    });
    expect(s).toEqual({
      startsAt: 1_700_000_000_000,
      priceLamports: "1500000000",
      solPaymentDestination: DEST,
      mintLimit: { id: 3, limit: 2 },
      botTax: true,
      unsupported: [],
    });
  });

  it("flags unsupported guards and defaults price to 0", () => {
    const s = summarizeGuards({ tokenPayment: some({}), gatekeeper: some({}) });
    expect(s.priceLamports).toBe("0");
    expect(s.unsupported.sort()).toEqual(["gatekeeper", "tokenPayment"]);
  });
});

describe("compute budget helpers", () => {
  it("adds a 10% margin and caps at 1.4M", () => {
    expect(computeUnitLimit(100_000)).toBe(110_000);
    expect(computeUnitLimit(12_345)).toBe(13_580);
    expect(computeUnitLimit(2_000_000)).toBe(1_400_000);
  });
  it("parses priority fees strictly", () => {
    expect(parsePriorityFee(undefined)).toBe(0n);
    expect(parsePriorityFee("12000")).toBe(12000n);
    expect(() => parsePriorityFee("-1")).toThrow();
    expect(() => parsePriorityFee("1e6")).toThrow();
  });
  it("computes total priority fee in lamports (rounded up)", () => {
    expect(priorityFeeLamports(200_000, 1_000_000n)).toBe(200_000n);
    expect(priorityFeeLamports(1, 1n)).toBe(1n);
  });
});
