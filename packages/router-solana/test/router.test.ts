import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  BlockhashCache,
  DoubleSubmitError,
  SolanaTxRouter,
  blockhashOf,
  estimatePriorityFee,
  getJitoTipInstruction,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  inspectWireTransaction,
  jitoEndpoints,
  SYSTEM_PROGRAM_ADDRESS,
  JITO_TIP_ACCOUNTS,
  maxPriceUnderCap,
  percentileOf,
  signatureOf,
  type SolanaRouterRpc,
} from "../src/index.js";
import { prepared, signTransfer } from "./helpers.js";

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const call = <T>(fn: () => T | Promise<T>) => ({ send: async () => fn() });

type Status = { slot: bigint; confirmations: bigint | null; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" };

class FakeChain {
  height = 100;
  blockhashValid = true;
  statuses = new Map<string, Status>();
  sends: Array<{ url: string; sig: string; opts: unknown }> = [];
  failUrls = new Set<string>();
  /** Land a tx after it was sent N times in total. */
  landAfter = new Map<string, number>();
  fees: bigint[] = [];

  rpc(url: string): SolanaRouterRpc {
    const b58 = getBase58Decoder();
    const rpc = {
      sendTransaction: (b64: string, opts: unknown) =>
        call(() => {
          if (this.failUrls.has(url)) throw new Error("boom");
          const bytes = new Uint8Array(getBase64Encoder().encode(b64));
          const sig = b58.decode(bytes.slice(1, 65));
          this.sends.push({ url, sig, opts });
          const n = this.landAfter.get(sig);
          if (n !== undefined && this.sends.filter((s) => s.sig === sig).length >= n) {
            this.statuses.set(sig, { slot: 7n, confirmations: 0n, err: null, confirmationStatus: "confirmed" });
          }
          return sig;
        }),
      getSignatureStatuses: (sigs: string[]) => call(() => ({ context: { slot: 1n }, value: sigs.map((s) => this.statuses.get(s) ?? null) })),
      getBlockHeight: () => call(() => BigInt(this.height)),
      isBlockhashValid: () => call(() => ({ context: { slot: 1n }, value: this.blockhashValid })),
      getRecentPrioritizationFees: () => call(() => this.fees.map((f, i) => ({ slot: BigInt(i), prioritizationFee: f }))),
    };
    return rpc as unknown as SolanaRouterRpc;
  }
}

function makeRouter(chain: FakeChain, extra: Partial<ConstructorParameters<typeof SolanaTxRouter>[1]> = {}, relay?: string) {
  return new SolanaTxRouter(
    { chain: "solana", rpcUrl: "http://a.local:8899", extraRpcUrls: ["http://b.local:8899"], privateRelayUrl: relay },
    { rpcFactory: (u) => chain.rpc(u), pollIntervalMs: 5, rebroadcastIntervalMs: 20, ...extra },
  );
}

async function wallets(n: number): Promise<KeyPairSigner[]> {
  return Promise.all(Array.from({ length: n }, () => generateKeyPairSigner()));
}

async function tx(payer: KeyPairSigner, lamports = 1000n, lvbh = 150) {
  const to = (await generateKeyPairSigner()).address;
  return signTransfer({ payer, to, lamports, blockhash: BLOCKHASH, lastValidBlockHeight: lvbh });
}

describe("wire helpers", () => {
  it("extracts signature and blockhash", async () => {
    const [w] = await wallets(1);
    const bytes = await tx(w!);
    expect(signatureOf(bytes)).toBe(getBase58Decoder().decode(bytes.slice(1, 65)));
    expect(blockhashOf(bytes)).toBe(BLOCKHASH);
    expect(inspectWireTransaction(bytes).durableNonce).toBe(false);
  });

  it("detects durable-nonce txs (AdvanceNonceAccount first)", async () => {
    const [w, nonce] = await wallets(2);
    const advance: Instruction = {
      programAddress: SYSTEM_PROGRAM_ADDRESS,
      accounts: [
        { address: nonce!.address, role: AccountRole.WRITABLE },
        { address: address("SysvarRecentB1ockHashes11111111111111111111"), role: AccountRole.READONLY },
        { address: w!.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: new Uint8Array([4, 0, 0, 0]),
    };
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(w!, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions([advance], m),
    );
    const bytes = new Uint8Array(getTransactionEncoder().encode(await signTransactionMessageWithSigners(msg)));
    expect(inspectWireTransaction(bytes).durableNonce).toBe(true);
  });
});

describe("instructions", () => {
  it("builds a jito tip transfer to a tip account", async () => {
    const [w] = await wallets(1);
    const ix = getJitoTipInstruction(w!.address, 10_000n);
    expect(ix.programAddress).toBe("11111111111111111111111111111111");
    expect(JITO_TIP_ACCOUNTS).toContain(ix.accounts![1]!.address);
    expect([...ix.data!]).toEqual([2, 0, 0, 0, 0x10, 0x27, 0, 0, 0, 0, 0, 0]);
    expect(() => getJitoTipInstruction(w!.address, 0n)).toThrow();
  });
  it("encodes compute budget ixs", () => {
    expect([...getSetComputeUnitPriceInstruction(5n).data!]).toEqual([3, 5, 0, 0, 0, 0, 0, 0, 0]);
    expect([...getSetComputeUnitLimitInstruction(200_000).data!]).toEqual([2, 0x40, 0x0d, 0x03, 0]);
  });
});

describe("fees", () => {
  it("percentile (nearest rank)", () => {
    const v = [5n, 1n, 4n, 2n, 3n];
    expect(percentileOf(v, 50)).toBe(3n);
    expect(percentileOf(v, 100)).toBe(5n);
    expect(percentileOf(v, 0)).toBe(1n);
    expect(percentileOf([], 75)).toBe(0n);
  });
  it("caps by maxTotalFee minus base fee and jito tip", async () => {
    expect(maxPriceUnderCap({ maxTotalFee: "25000", jitoTip: "10000" }, 200_000, 1)).toBe(50_000n);
    expect(maxPriceUnderCap({ maxTotalFee: "4000" }, 200_000, 1)).toBe(0n);
    expect(maxPriceUnderCap({}, 200_000, 1)).toBeUndefined();
    const chain = new FakeChain();
    chain.fees = [0n, 100n, 1_000_000n, 2_000_000n];
    const rpc = chain.rpc("x");
    const uncapped = await estimatePriorityFee(rpc, [], 75);
    expect(uncapped).toMatchObject({ microLamportsPerCu: 1_000_000n, capped: false, samples: 4 });
    const capped = await estimatePriorityFee(rpc, [], 75, { fees: { maxTotalFee: "25000", jitoTip: "10000" } });
    expect(capped).toMatchObject({ microLamportsPerCu: 50_000n, uncapped: 1_000_000n, capped: true });
  });
});

describe("BlockhashCache", () => {
  it("prefetches, shares in-flight requests and never moves backwards", async () => {
    let n = 0;
    const slots = [10, 12, 11];
    const rpc = {
      getLatestBlockhash: () => ({
        send: async () => {
          const slot = slots[Math.min(n++, slots.length - 1)]!;
          return { context: { slot: BigInt(slot) }, value: { blockhash: `h${slot}`, lastValidBlockHeight: BigInt(slot + 150) } };
        },
      }),
    };
    const cache = new BlockhashCache({ rpc: rpc as never, intervalMs: 10_000 });
    const first = await cache.start();
    expect(first).toMatchObject({ blockhash: "h10", lastValidBlockHeight: 160 });
    const [a, b] = await Promise.all([cache.refresh(), cache.refresh()]);
    expect(a).toBe(b);
    expect(n).toBe(2);
    await cache.refresh(); // slot 11 arrives late, ignored
    expect(cache.peek()?.blockhash).toBe("h12");
    expect(await cache.get()).toBe(cache.peek());
    cache.stop();
    expect(cache.running).toBe(false);
  });

  it("recovers after an RPC that throws synchronously", async () => {
    let fail = true;
    const rpc = {
      getLatestBlockhash: () => {
        if (fail) throw new Error("sync boom");
        return { send: async () => ({ context: { slot: 1n }, value: { blockhash: "h1", lastValidBlockHeight: 151n } }) };
      },
    };
    const cache = new BlockhashCache({ rpc: rpc as never });
    await expect(cache.refresh()).rejects.toThrow("sync boom");
    fail = false;
    await expect(cache.refresh()).resolves.toMatchObject({ blockhash: "h1" });
  });
});

describe("SolanaTxRouter.send", () => {
  it("fans out every tx to all RPCs with skipPreflight and maxRetries 0", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const ws = await wallets(3);
    const items = await Promise.all(ws.map(async (w, i) => ({ prepared: prepared(`w${i}`, 150), signed: await tx(w) })));
    const sent = await router.send(items, {});
    expect(sent.map((s) => s.id)).toEqual(items.map((i) => signatureOf(i.signed)));
    expect(chain.sends).toHaveLength(6);
    expect(chain.sends[0]!.opts).toMatchObject({ encoding: "base64", skipPreflight: true, maxRetries: 0n });
    for (const s of sent) expect(s.via.sort()).toEqual(["rpc0:a.local:8899", "rpc1:b.local:8899"]);
  });

  it("records failures per endpoint without throwing", async () => {
    const chain = new FakeChain();
    chain.failUrls.add("http://b.local:8899");
    const errors: string[] = [];
    const router = makeRouter(chain, { onError: (_e, ctx) => errors.push(ctx) });
    const [w] = await wallets(1);
    const [s] = await router.send([{ prepared: prepared("w0", 150), signed: await tx(w!) }], {});
    expect(s!.via).toEqual(["rpc0:a.local:8899"]);
    expect(errors).toHaveLength(1);
  });

  it("refuses a different tx for a wallet whose tx may still land", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const [w] = await wallets(1);
    const t1 = await tx(w!, 1000n);
    const t2 = await tx(w!, 2000n);
    await expect(router.send([{ prepared: prepared("w0", 150), signed: t1 }, { prepared: prepared("w0", 150), signed: t2 }], {})).rejects.toBeInstanceOf(DoubleSubmitError);
    expect(chain.sends).toHaveLength(0);

    await router.send([{ prepared: prepared("w0", 150), signed: t1 }], {});
    // Re-sending the identical tx is fine.
    await router.send([{ prepared: prepared("w0", 150), signed: t1 }], {});
    await expect(router.send([{ prepared: prepared("w0", 150), signed: t2 }], {})).rejects.toBeInstanceOf(DoubleSubmitError);
    // Processed, not confirmed: still refuse.
    chain.statuses.set(signatureOf(t1), { slot: 1n, confirmations: 0n, err: null, confirmationStatus: "processed" });
    await expect(router.send([{ prepared: prepared("w0", 150), signed: t2 }], {})).rejects.toBeInstanceOf(DoubleSubmitError);
    // Once expired with no status it's safe to replace.
    chain.statuses.delete(signatureOf(t1));
    chain.height = 151;
    await router.send([{ prepared: prepared("w0", 300), signed: t2 }], {});
    expect(router.pendingFor("w0")).toBe(signatureOf(t2));
  });

  it("submits to Jito: one bundle for <=5 txs, sendTransaction each above that", async () => {
    const chain = new FakeChain();
    const calls: Array<{ url: string; method: string; params: unknown[] }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, method: body.method, params: body.params });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const router = makeRouter(chain, { fetch: fakeFetch }, "http://jito.local/");
    const ws = await wallets(7);
    const items = await Promise.all(ws.map(async (w, i) => ({ prepared: prepared(`w${i}`, 150), signed: await tx(w) })));

    const sent = await router.send(items.slice(0, 5), { jitoTip: "1000" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://jito.local/api/v1/bundles", method: "sendBundle" });
    expect((calls[0]!.params[0] as string[]).length).toBe(5);
    expect(sent[0]!.via).toContain("jito:bundle");

    // privateSubmission: Jito only, never the public RPCs (also on rebroadcast).
    calls.length = 0;
    chain.sends.length = 0;
    const router2 = makeRouter(chain, { fetch: fakeFetch, rebroadcastIntervalMs: 10 }, "http://jito.local/api/v1/bundles");
    const sent2 = await router2.send(items, { privateSubmission: true, jitoTip: "1000" });
    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.url === "http://jito.local/api/v1/transactions" && c.method === "sendTransaction")).toBe(true);
    await router2.confirm(sent2.slice(0, 1), { timeoutMs: 80 });
    expect(chain.sends).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(7);
  });

  it("validates privateSubmission config", async () => {
    const [w] = await wallets(1);
    const item = [{ prepared: prepared("w0"), signed: await tx(w!) }];
    await expect(makeRouter(new FakeChain()).send(item, { privateSubmission: true, jitoTip: "1000" })).rejects.toThrow(/privateRelayUrl/);
    await expect(makeRouter(new FakeChain(), {}, "http://jito.local").send(item, { privateSubmission: true })).rejects.toThrow(/jitoTip/);
  });

  it("concurrent send() calls can't both replace an expired tx", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const [w] = await wallets(1);
    await router.send([{ prepared: prepared("w0", 150), signed: await tx(w!) }], {});
    chain.height = 151;
    const results = await Promise.allSettled([
      router.send([{ prepared: prepared("w0", 300), signed: await tx(w!, 2n, 300) }], {}),
      router.send([{ prepared: prepared("w0", 300), signed: await tx(w!, 3n, 300) }], {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("resolves jito endpoints", () => {
    expect(jitoEndpoints("https://x.jito.wtf")).toEqual({ bundles: "https://x.jito.wtf/api/v1/bundles", transactions: "https://x.jito.wtf/api/v1/transactions" });
    expect(jitoEndpoints("https://x.jito.wtf/api/v1/transactions").bundles).toBe("https://x.jito.wtf/api/v1/bundles");
  });
});

describe("SolanaTxRouter.confirm", () => {
  it("rebroadcasts until confirmed", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const [w] = await wallets(1);
    const t = await tx(w!);
    chain.landAfter.set(signatureOf(t), 6); // 2 initial sends + 2 rebroadcast rounds
    const sent = await router.send([{ prepared: prepared("w0", 150), signed: t }], {});
    const [o] = await router.confirm(sent, { timeoutMs: 5000 });
    expect(o).toMatchObject({ status: "confirmed", slotOrBlock: 7 });
    expect(chain.sends.length).toBeGreaterThanOrEqual(6);
    expect(router.pendingFor("w0")).toBeUndefined();
  });

  it("reports failed, expired (by height and by blockhash validity) and preconfirmed", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const ws = await wallets(4);
    const t = await Promise.all(ws.map((w) => tx(w)));
    const sent = await router.send(
      [
        { prepared: prepared("fail", 150), signed: t[0]! },
        { prepared: prepared("exp-height", 150), signed: t[1]! },
        { prepared: prepared("exp-hash"), signed: t[2]! },
        { prepared: prepared("pre", 150), signed: t[3]! },
      ],
      {},
    );
    chain.statuses.set(sent[0]!.id, { slot: 3n, confirmations: 0n, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" });
    chain.statuses.set(sent[3]!.id, { slot: 4n, confirmations: 0n, err: null, confirmationStatus: "processed" });
    chain.height = 151;
    chain.blockhashValid = false;
    const out = await router.confirm(sent, { timeoutMs: 2000, acceptPreconf: true });
    expect(out.map((o) => o.status)).toEqual(["failed", "expired", "expired", "preconfirmed"]);
    expect(out[0]!.error).toContain("InstructionError");
  });

  it("resumes rebroadcasting when a processed tx's fork is dropped", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const [w] = await wallets(1);
    const sent = await router.send([{ prepared: prepared("w0", 150), signed: await tx(w!) }], {});
    chain.statuses.set(sent[0]!.id, { slot: 1n, confirmations: 0n, err: null, confirmationStatus: "processed" });
    setTimeout(() => {
      chain.statuses.delete(sent[0]!.id); // fork dropped
      chain.landAfter.set(sent[0]!.id, chain.sends.length + 1);
    }, 30);
    const [o] = await router.confirm(sent, { timeoutMs: 3000 });
    expect(o!.status).toBe("confirmed");
  });

  it("returns current status at timeout", async () => {
    const chain = new FakeChain();
    const router = makeRouter(chain);
    const [w] = await wallets(1);
    const sent = await router.send([{ prepared: prepared("w0", 150), signed: await tx(w!) }], {});
    const started = Date.now();
    const [o] = await router.confirm(sent, { timeoutMs: 100 });
    expect(o!.status).toBe("sent");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
