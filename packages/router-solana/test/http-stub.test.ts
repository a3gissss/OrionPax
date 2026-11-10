// Exercises the router over real HTTP (createSolanaRpc + fetch) against local stubs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSolanaRpc, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { BlockhashCache, SolanaTxRouter, estimatePriorityFee, getJitoTipInstruction, signatureOf } from "../src/index.js";
import { prepared, signTransfer } from "./helpers.js";
import { StubServer } from "./stub.js";

const stub = new StubServer();
let url = "";
let wallets: KeyPairSigner[] = [];

beforeAll(async () => {
  url = await stub.start();
  wallets = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()));
});
afterAll(() => stub.stop());

describe("router over HTTP stubs", () => {
  it("BlockhashCache + 10 wallets: fan-out to the same RPC twice, Jito bundle, confirm all", async () => {
    const cache = new BlockhashCache({ rpcUrl: url, intervalMs: 50 });
    const bh = await cache.start();
    cache.stop();
    expect(bh.lastValidBlockHeight).toBe(stub.height + 150);

    const dest = (await generateKeyPairSigner()).address;
    const items = await Promise.all(
      wallets.map(async (w, i) => ({
        prepared: prepared(`w${i}`, bh.lastValidBlockHeight),
        signed: await signTransfer({
          payer: w, to: dest, lamports: 1000n, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight,
          extra: i === 0 ? [getJitoTipInstruction(w.address, 1000n)] : [],
        }),
      })),
    );
    // Wallet 9 only lands after the rebroadcast loop resends it.
    stub.landAfter.set(signatureOf(items[9]!.signed), 4);

    const router = new SolanaTxRouter(
      { chain: "solana", rpcUrl: url, extraRpcUrls: [url], privateRelayUrl: url },
      { pollIntervalMs: 20, rebroadcastIntervalMs: 50 },
    );
    const sent = await router.send(items.slice(0, 5), { jitoTip: "1000" });
    expect(stub.jitoCalls).toHaveLength(1);
    expect(stub.jitoCalls[0]).toMatchObject({ path: "/api/v1/bundles", method: "sendBundle" });
    sent.push(...(await router.send(items.slice(5), {})));

    expect(sent.map((s) => s.id)).toEqual(items.map((i) => signatureOf(i.signed)));
    for (const s of sent) expect(s.via.filter((v) => v.startsWith("rpc"))).toHaveLength(2);
    const sendCalls = stub.calls.filter((c) => c.method === "sendTransaction");
    expect(sendCalls).toHaveLength(20);
    expect(sendCalls[0]!.params[1]).toMatchObject({ encoding: "base64", skipPreflight: true, maxRetries: 0 });

    const out = await router.confirm(sent, { timeoutMs: 5000 });
    expect(out.map((o) => o.status)).toEqual(Array(10).fill("confirmed"));
    expect(stub.receipts.get(sent[9]!.id)).toBeGreaterThanOrEqual(4);
  });

  it("expired blockhash resolves to expired", async () => {
    const router = new SolanaTxRouter({ chain: "solana", rpcUrl: url }, { pollIntervalMs: 20, rebroadcastIntervalMs: 50 });
    const lvbh = stub.height - 1; // already past
    const signed = await signTransfer({
      payer: wallets[0]!, to: wallets[1]!.address, lamports: 7n, blockhash: stub.blockhash, lastValidBlockHeight: lvbh,
    });
    stub.landAfter.set(signatureOf(signed), Infinity);
    const sent = await router.send([{ prepared: prepared("w0", lvbh), signed }], {});
    const [o] = await router.confirm(sent, { timeoutMs: 3000 });
    expect(o!.status).toBe("expired");
  });

  it("estimatePriorityFee over HTTP", async () => {
    stub.prioritizationFees = [0, 10, 20, 30];
    const est = await estimatePriorityFee(createSolanaRpc(url), [wallets[0]!.address], 50);
    expect(est.microLamportsPerCu).toBe(10n);
  });
});
