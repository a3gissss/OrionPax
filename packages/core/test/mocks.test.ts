import { describe, expect, it } from "vitest";
import { MockAdapter, MockRouter, mockSigner, mockWallets } from "../src/index.js";

describe("core mocks", () => {
  it("runs a 10-wallet mock mint end to end", async () => {
    const adapter = new MockAdapter();
    const router = new MockRouter();
    const wallets = mockWallets(10);
    router.failWallets.add("w3");
    const target = { kind: "nft", chain: "base", address: "0xabc", quantity: 1 } as const;
    expect(adapter.supports(target)).toBe(true);
    const signed = await Promise.all(wallets.map(async (w) => {
      const prepared = await adapter.prepare(target, w, {});
      return { prepared, signed: await mockSigner(w).signTransaction(prepared.unsigned) };
    }));
    const outcomes = await router.confirm(await router.send(signed));
    expect(outcomes).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === "failed").map((o) => o.sent.walletId)).toEqual(["w3"]);
  });
});
