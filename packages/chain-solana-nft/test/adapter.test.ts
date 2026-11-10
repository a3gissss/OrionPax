import { describe, expect, it } from "vitest";
import { Keypair, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { publicKey as toPk, sol, some } from "@metaplex-foundation/umi";
import type { NftMintTarget, WalletRef } from "@mint-engine/core";
import { SolanaCoreCandyMachineAdapter, CORE_CANDY_GUARD_PROGRAM_ID } from "../src/index.js";
import { buildFixture, decodeBase64, type Fixture } from "./fixtures.js";

const NOW_S = 1_800_000_000;

function setup(f: Fixture, nowMs = NOW_S * 1000) {
  return new SolanaCoreCandyMachineAdapter(undefined, { umi: f.umi, now: () => nowMs });
}

function target(f: Fixture, quantity = 1): NftMintTarget {
  return { kind: "nft", chain: "solana", address: f.candyMachine, quantity };
}

function walletFor(kp: Keypair, id = "w1"): WalletRef {
  return { id, label: `Wallet ${id}`, family: "solana", address: kp.publicKey.toBase58() };
}

function cbIx(tx: VersionedTransaction) {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]!.equals(ComputeBudgetProgram.programId))
    .map((ix) => Buffer.from(ix.data));
}

describe("supports", () => {
  it("accepts solana nft targets with no or core-candy-machine style only", () => {
    const f = buildFixture();
    const a = setup(f);
    expect(a.supports(target(f))).toBe(true);
    expect(a.supports({ ...target(f), style: "core-candy-machine" })).toBe(true);
    expect(a.supports({ ...target(f), style: "erc721a" })).toBe(false);
    expect(a.supports({ ...target(f), chain: "base" })).toBe(false);
    expect(a.supports({ kind: "token", chain: "solana", tokenAddress: "x", launchpadAddress: "y", spendPerWallet: "1", slippageBps: 1 })).toBe(false);
  });
});

describe("detect", () => {
  it("decodes candy machine + guard set into MintState", async () => {
    const f = buildFixture({ itemsAvailable: 10, itemsRedeemed: 3, priceSol: 0.1, mintLimit: 1, startDate: NOW_S - 60 });
    const s = await setup(f).detect(target(f));
    expect(s).toEqual({
      live: true,
      startsAt: (NOW_S - 60) * 1000,
      pricePerUnit: "100000000",
      maxPerWallet: 1,
      remainingSupply: 7,
      detectedStyle: "core-candy-machine",
    });
  });

  it("is not live before startDate or when sold out", async () => {
    const early = buildFixture({ startDate: NOW_S + 60 });
    expect((await setup(early).detect(target(early))).live).toBe(false);
    const sold = buildFixture({ itemsAvailable: 5, itemsRedeemed: 5 });
    const s = await setup(sold).detect(target(sold));
    expect(s.live).toBe(false);
    expect(s.remainingSupply).toBe(0);
  });

  it("rejects accounts not owned by the Core Candy Machine program", async () => {
    const f = buildFixture();
    f.rpc.accounts.get(f.candyMachine)!.owner = CORE_CANDY_GUARD_PROGRAM_ID;
    await expect(setup(f).detect(target(f))).rejects.toThrow(/not owned by the Core Candy Machine/);
  });
});

describe("prepare", () => {
  it("builds a partially-signed mint tx with compute budget and an asset co-signature", async () => {
    const f = buildFixture({ priceSol: 0.25 });
    const a = setup(f);
    const kp = Keypair.generate();
    const p = await a.prepare(target(f), walletFor(kp), { priorityFee: "5000" });

    expect(p.chain).toBe("solana");
    expect(p.walletId).toBe("w1");
    expect(p.value).toBe("250000000");
    expect(p.validUntil).toBe(1234);
    expect(p.computeOrGas).toBe(110_000); // 100k simulated * 1.1

    const tx = VersionedTransaction.deserialize(p.unsigned);
    const keys = tx.message.staticAccountKeys;
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(keys[0]!.equals(kp.publicKey)).toBe(true); // fee payer = wallet
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true); // wallet slot left empty
    expect(tx.signatures[1]!.some((b) => b !== 0)).toBe(true); // asset signed

    // asset signature is valid over the final message
    const msg = tx.message.serialize();
    expect(f.umi.eddsa.verify(msg, tx.signatures[1]!, toPk(keys[1]!.toBase58()))).toBe(true);

    // compute budget: limit first, then price
    const [limit, price] = cbIx(tx);
    expect(limit![0]).toBe(2);
    expect(limit!.readUInt32LE(1)).toBe(110_000);
    expect(price![0]).toBe(3);
    expect(price!.readBigUInt64LE(1)).toBe(5000n);

    // the mint goes through the candy guard
    const last = tx.message.compiledInstructions.at(-1)!;
    expect(keys[last.programIdIndex]!.toBase58()).toBe(CORE_CANDY_GUARD_PROGRAM_ID);

    // simulation used sigVerify:false
    expect(f.rpc.simCalls[0]!.config).toMatchObject({ sigVerify: false, encoding: "base64" });
  });

  it("wallet co-signing keeps the asset signature (vault-compatible partial signing)", async () => {
    const f = buildFixture();
    const kp = Keypair.generate();
    const p = await setup(f).prepare(target(f), walletFor(kp), {});
    const tx = VersionedTransaction.deserialize(p.unsigned);
    const assetSig = Buffer.from(tx.signatures[1]!);
    tx.sign([kp]);
    const msg = tx.message.serialize();
    expect(f.umi.eddsa.verify(msg, tx.signatures[0]!, toPk(kp.publicKey.toBase58()))).toBe(true);
    expect(Buffer.from(tx.signatures[1]!).equals(assetSig)).toBe(true);
  });

  it("omits setComputeUnitPrice when no priority fee is given", async () => {
    const f = buildFixture();
    const p = await setup(f).prepare(target(f), walletFor(Keypair.generate()), {});
    expect(cbIx(VersionedTransaction.deserialize(p.unsigned)).map((d) => d[0])).toEqual([2]);
  });

  it("uses a new asset keypair per prepare", async () => {
    const f = buildFixture({ mintLimit: null });
    const a = setup(f);
    const w = walletFor(Keypair.generate());
    const k1 = VersionedTransaction.deserialize((await a.prepare(target(f), w, {})).unsigned).message.staticAccountKeys[1]!;
    const k2 = VersionedTransaction.deserialize((await a.prepare(target(f), w, {})).unsigned).message.staticAccountKeys[1]!;
    expect(k1.equals(k2)).toBe(false);
  });

  it("refuses quantity above the guard's mintLimit", async () => {
    const f = buildFixture({ mintLimit: 1 });
    await expect(setup(f).prepare(target(f, 2), walletFor(Keypair.generate()), {}))
      .rejects.toThrow(/exceeds the guard's mintLimit of 1/);
  });

  it("refuses a wallet that already reached its mintLimit", async () => {
    const f = buildFixture({ mintLimit: 1 });
    const kp = Keypair.generate();
    f.setMintCounter(toPk(kp.publicKey.toBase58()), 1);
    const a = setup(f);
    expect(await a.mintedByWallet(target(f), walletFor(kp))).toBe(1);
    await expect(a.prepare(target(f), walletFor(kp), {})).rejects.toThrow(/mintLimit reached/);
    // a different wallet is fine
    await expect(a.prepare(target(f), walletFor(Keypair.generate(), "w2"), {})).resolves.toBeDefined();
  });

  it("falls back to a default CU limit when simulation fails (e.g. not live yet)", async () => {
    const f = buildFixture();
    f.rpc.simResult = { err: { InstructionError: [2, { Custom: 6029 }] }, logs: ["mint not started"] };
    const p = await setup(f).prepare(target(f), walletFor(Keypair.generate()), {});
    expect(p.computeOrGas).toBe(250_000);
    expect(p.description).toMatch(/simulation failed/);
  });

  it("refuses CAPTCHA/third-party guards and unsupported guards", async () => {
    const gk = buildFixture({ extraGuards: { gatekeeper: some({ gatekeeperNetwork: toPk("11111111111111111111111111111111"), expireOnUse: true }) } });
    await expect(setup(gk).prepare(target(gk), walletFor(Keypair.generate()), {})).rejects.toThrow(/will not handle: gatekeeper/);
    const grouped = buildFixture({ groups: true });
    await expect(setup(grouped).prepare(target(grouped), walletFor(Keypair.generate()), {})).rejects.toThrow(/guard groups/);
  });

  it("rejects non-solana wallets, bad quantities and bad priority fees", async () => {
    const f = buildFixture();
    const a = setup(f);
    const w = walletFor(Keypair.generate());
    await expect(a.prepare(target(f), { ...w, family: "evm" }, {})).rejects.toThrow(/not a Solana wallet/);
    await expect(a.prepare(target(f, 0), w, {})).rejects.toThrow(/invalid quantity/);
    await expect(a.prepare(target(f), w, { priorityFee: "1.5" })).rejects.toThrow(/priorityFee/);
  });

  it("refuses quantity above remaining supply", async () => {
    const f = buildFixture({ itemsAvailable: 4, itemsRedeemed: 4, mintLimit: null });
    await expect(setup(f).prepare(target(f), walletFor(Keypair.generate()), {})).rejects.toThrow(/remaining supply/);
  });
});

describe("guard edge cases", () => {
  it("caps remaining supply by the redeemedAmount guard", async () => {
    const f = buildFixture({ itemsAvailable: 100, itemsRedeemed: 9, mintLimit: null, extraGuards: { redeemedAmount: some({ maximum: 10 }) } });
    const a = setup(f);
    expect((await a.detect(target(f))).remainingSupply).toBe(1);
    await expect(a.prepare(target(f, 2), walletFor(Keypair.generate()), {})).rejects.toThrow(/remaining supply 1/);
  });

  it("refuses quantity > 1 when botTax is set", async () => {
    const f = buildFixture({ mintLimit: 5, extraGuards: { botTax: some({ lamports: sol(0.01), lastInstruction: true }) } });
    await expect(setup(f).prepare(target(f, 2), walletFor(Keypair.generate()), {})).rejects.toThrow(/botTax/);
  });

  it("enforces FeeStrategy.maxTotalFee", async () => {
    const f = buildFixture();
    // 110k CU * 1e6 micro-lamports = 110_000 lamports priority + 10_000 base
    await expect(setup(f).prepare(target(f), walletFor(Keypair.generate()), { priorityFee: "1000000", maxTotalFee: "50000" }))
      .rejects.toThrow(/exceeds maxTotalFee/);
    await expect(setup(f).prepare(target(f), walletFor(Keypair.generate()), { priorityFee: "1000000", maxTotalFee: "120000" }))
      .resolves.toBeDefined();
  });

  it("reports a bot-taxed simulation as failed", async () => {
    const f = buildFixture();
    const a = setup(f);
    const p = await a.prepare(target(f), walletFor(Keypair.generate()), {});
    f.rpc.simResult = { err: null, logs: ["Program log: Candy Guard Botting is taxed at 10000000 lamports"], unitsConsumed: 5000 };
    expect(await a.simulate(p)).toMatchObject({ ok: false, error: expect.stringMatching(/bot tax/) });
  });
});

describe("simulate", () => {
  it("returns CU used and logs; prefers the signed tx when given", async () => {
    const f = buildFixture();
    const a = setup(f);
    const kp = Keypair.generate();
    const p = await a.prepare(target(f), walletFor(kp), {});
    f.rpc.simCalls = [];
    f.rpc.simResult = { err: null, logs: ["a", "b"], unitsConsumed: 42_000 };
    const signed = VersionedTransaction.deserialize(p.unsigned);
    signed.sign([kp]);
    const r = await a.simulate(p, signed.serialize());
    expect(r).toEqual({ ok: true, logs: ["a", "b"], computeOrGasUsed: 42_000 });
    expect(Buffer.from(decodeBase64(f.rpc.simCalls[0]!.tx)).equals(Buffer.from(signed.serialize()))).toBe(true);
    expect(f.rpc.simCalls[0]!.config).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });

    f.rpc.simResult = { err: "BlockhashNotFound", logs: [] };
    expect(await a.simulate(p)).toMatchObject({ ok: false, error: "BlockhashNotFound" });
  });
});
