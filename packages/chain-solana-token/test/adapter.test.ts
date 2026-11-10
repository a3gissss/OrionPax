import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { JITO_TIP_ACCOUNTS, type TokenLaunchTarget, type WalletRef } from "@mint-engine/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, constantProductSolCost, createPumpFunLaunchpad, feeOf, getAssociatedTokenAddress,
  PUMP_BUY_DISCRIMINATOR, PUMP_CURVE_DISCRIMINATOR, PUMP_GLOBAL_DISCRIMINATOR, SolanaTokenAdapter, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const programId = Keypair.generate().publicKey;
const pump = createPumpFunLaunchpad({ programId });
const mint = Keypair.generate().publicKey;
const feeRecipient = Keypair.generate().publicKey;
const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);

function globalData(feeBps = 100n): Buffer {
  const b = Buffer.alloc(113);
  b.set(PUMP_GLOBAL_DISCRIMINATOR, 0);
  b[8] = 1;
  b.set(Keypair.generate().publicKey.toBuffer(), 9);
  b.set(feeRecipient.toBuffer(), 41);
  b.writeBigUInt64LE(feeBps, 105);
  return b;
}

function curveData(o: { vTok?: bigint; vSol?: bigint; rTok?: bigint; complete?: boolean } = {}): Buffer {
  const b = Buffer.alloc(81);
  b.set(PUMP_CURVE_DISCRIMINATOR, 0);
  b.writeBigUInt64LE(o.vTok ?? 1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(o.vSol ?? 30_000_000_000n, 16);
  b.writeBigUInt64LE(o.rTok ?? 793_100_000_000_000n, 24);
  b.writeBigUInt64LE(0n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = o.complete ? 1 : 0;
  return b;
}

function mintData(decimals = 6): Buffer {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return b;
}

function fakeConnection(curve: Buffer, opts: { curveOwner?: PublicKey } = {}): Connection {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        if (k.equals(pump.curveAddress(mint))) return { data: curve, owner: opts.curveOwner ?? programId, lamports: 1, executable: false };
        if (k.equals(mint)) return { data: mintData(), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
        if (k.equals(global)) return { data: globalData(), owner: programId, lamports: 1, executable: false };
        return null;
      });
    },
    async getLatestBlockhash() {
      return { blockhash, lastValidBlockHeight: 1234 };
    },
    async getMinimumBalanceForRentExemption(size: number) {
      return size * 10;
    },
  } as unknown as Connection;
}

const target: TokenLaunchTarget = {
  kind: "token", chain: "solana", tokenAddress: mint.toBase58(), launchpadAddress: programId.toBase58(),
  spendPerWallet: "100000000", slippageBps: 500,
};
const user = Keypair.generate().publicKey;
const wallet: WalletRef = { id: "w1", label: "Wallet 1", family: "solana", address: user.toBase58() };

describe("pump.fun quote", () => {
  it("never lets maxSolCost exceed spendPerWallet; slippage headroom sits inside the budget", () => {
    const state = pump.decode(mint, curveData(), [globalData()]);
    const spend = 100_000_000n;
    const q = pump.quoteBuy(state, spend, 500);
    expect(q.expectedTokensOut).toBeGreaterThan(0n);
    expect(q.minTokensOut).toBe(q.expectedTokensOut); // exact-out
    const cost = constantProductSolCost(state.virtualSolReserves, state.virtualTokenReserves, q.expectedTokensOut);
    expect(q.expectedSolCost).toBe(cost + feeOf(cost, 100n));
    const budget = (spend * 10_000n) / 10_500n;
    expect(q.expectedSolCost).toBeLessThanOrEqual(budget);
    expect(q.expectedSolCost).toBeGreaterThan(budget - budget / 1000n);
    expect(q.maxSolCost).toBeLessThanOrEqual(spend);
    expect(q.maxSolCost).toBe((q.expectedSolCost * 10_500n) / 10_000n);
  });

  it("with zero slippage spends ~all of the budget", () => {
    const state = pump.decode(mint, curveData(), [globalData()]);
    const q = pump.quoteBuy(state, 100_000_000n, 0);
    expect(q.maxSolCost).toBe(q.expectedSolCost);
    expect(q.maxSolCost).toBeLessThanOrEqual(100_000_000n);
    expect(q.maxSolCost).toBeGreaterThan(99_900_000n);
  });

  it("slippage guard: a stale quote's maxSolCost no longer covers the cost after the price moves", () => {
    const fee = 100n;
    const before = pump.decode(mint, curveData(), [globalData()]);
    const q = pump.quoteBuy(before, 100_000_000n, 100); // 1%
    const onChainTotal = (vSol: bigint, vTok: bigint) => {
      const c = constantProductSolCost(vSol, vTok, q.expectedTokensOut);
      return c + feeOf(c, fee);
    };
    // Unchanged price: the fixture/pump check `cost + fee <= maxSolCost` passes.
    expect(onChainTotal(before.virtualSolReserves, before.virtualTokenReserves)).toBeLessThanOrEqual(q.maxSolCost);
    // A 10 SOL buy lands first and moves the curve.
    const whaleTokens = pump.quoteBuy(before, 10_000_000_000n, 0).expectedTokensOut;
    const whaleCost = constantProductSolCost(before.virtualSolReserves, before.virtualTokenReserves, whaleTokens);
    const vSol = before.virtualSolReserves + whaleCost;
    const vTok = before.virtualTokenReserves - whaleTokens;
    expect(onChainTotal(vSol, vTok)).toBeGreaterThan(q.maxSolCost); // -> TooMuchSolRequired (6002)
  });

  it("caps tokens out at the real token reserves", () => {
    const state = pump.decode(mint, curveData({ rTok: 1_000n }), [globalData()]);
    expect(pump.quoteBuy(state, 10_000_000_000n, 0).expectedTokensOut).toBe(1_000n);
  });

  it("rejects foreign account data", () => {
    expect(() => pump.decode(mint, Buffer.alloc(81), [globalData()])).toThrow(/BondingCurve/);
    expect(() => pump.decode(mint, curveData(), [null])).toThrow(/global/);
  });
});

describe("SolanaTokenAdapter", () => {
  it("supports only solana token targets for registered launchpads", () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    expect(a.supports(target)).toBe(true);
    expect(a.supports({ ...target, launchpadAddress: Keypair.generate().publicKey.toBase58() })).toBe(false);
    expect(a.supports({ ...target, chain: "base" })).toBe(false);
    expect(a.supports({ kind: "nft", chain: "solana", address: mint.toBase58(), quantity: 1 })).toBe(false);
  });

  it("detects live curve state and price", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    const s = await a.detect(target);
    expect(s.live).toBe(true);
    expect(s.detectedStyle).toBe("pump-fun");
    expect(s.pricePerUnit).toBe(((30_000_000_000n * 1_000_000n) / 1_073_000_000_000_000n).toString());
    expect(s.remainingSupply).toBe(793_100_000);
  });

  it("reports complete curves as not live and refuses to prepare", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData({ complete: true })), launchpads: [pump] });
    expect((await a.detect(target)).live).toBe(false);
    await expect(a.prepare(target, wallet, {})).rejects.toThrow(/complete/);
  });

  it("rejects curves not owned by the launchpad program", async () => {
    const a = new SolanaTokenAdapter({
      connection: fakeConnection(curveData(), { curveOwner: Keypair.generate().publicKey }), launchpads: [pump],
    });
    await expect(a.detect(target)).rejects.toThrow(/not owned/);
  });

  it("builds compute budget + idempotent ATA + buy with slippage-bounded maxSolCost", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump], computeUnitLimit: 90_000 });
    const tx = await a.prepare(target, wallet, { priorityFee: "50000" });
    expect(tx.walletId).toBe("w1");
    expect(tx.validUntil).toBe(1234);
    expect(tx.computeOrGas).toBe(90_000);
    // value = curve cap + ATA rent (ATA does not exist yet; fake rent = 165 * 10).
    expect(tx.value).toBe((tx.quote.maxSolCost + 1650n).toString());

    const vtx = VersionedTransaction.deserialize(tx.unsigned);
    const keys = vtx.message.staticAccountKeys;
    expect(keys[0]!.equals(user)).toBe(true);
    const ixs = vtx.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex]!, data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map((i) => keys[i]!) }));
    expect(ixs.map((i) => i.program.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), programId.toBase58(),
    ]);
    expect(ixs[0]!.data[0]).toBe(2); // SetComputeUnitLimit
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(90_000);
    expect(ixs[1]!.data[0]).toBe(3); // SetComputeUnitPrice
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(50_000n);
    expect(ixs[2]!.data).toEqual(Buffer.from([1])); // CreateIdempotent
    const ata = getAssociatedTokenAddress(mint, user);
    expect(ixs[2]!.accounts[1]!.equals(ata)).toBe(true);

    const buy = ixs[3]!;
    expect(buy.data.subarray(0, 8)).toEqual(Buffer.from(PUMP_BUY_DISCRIMINATOR));
    expect(buy.data.readBigUInt64LE(8)).toBe(tx.quote.expectedTokensOut);
    expect(buy.data.readBigUInt64LE(16)).toBe(tx.quote.maxSolCost);
    expect(buy.accounts).toHaveLength(12);
    expect(buy.accounts[1]!.equals(feeRecipient)).toBe(true);
    expect(buy.accounts[3]!.equals(pump.curveAddress(mint))).toBe(true);
    expect(buy.accounts[4]!.equals(getAssociatedTokenAddress(mint, pump.curveAddress(mint)))).toBe(true);
    expect(buy.accounts[5]!.equals(ata)).toBe(true);
    expect(buy.accounts[6]!.equals(user)).toBe(true);
  });

  it("omits the CU price ix without a priority fee and enforces maxTotalFee", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    const tx = await a.prepare(target, wallet, {});
    expect(VersionedTransaction.deserialize(tx.unsigned).message.compiledInstructions).toHaveLength(3);
    await expect(a.prepare(target, wallet, { priorityFee: "1000000", maxTotalFee: "10000" })).rejects.toThrow(/maxTotalFee/);
  });

  it("prepareMany builds one tx per wallet from a single snapshot", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    const ws = Array.from({ length: 10 }, (_, i) => ({ ...wallet, id: `w${i}`, address: Keypair.generate().publicKey.toBase58() }));
    const txs = await a.prepareMany(target, ws, {});
    expect(txs.map((t) => t.walletId)).toEqual(ws.map((w) => w.id));
    txs.forEach((t, i) => {
      const keys = VersionedTransaction.deserialize(t.unsigned).message.staticAccountKeys;
      expect(keys[0]!.toBase58()).toBe(ws[i]!.address);
    });
  });

  it("counts the jito tip toward maxTotalFee", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    await expect(a.prepare(target, wallet, { jitoTip: "1000000", maxTotalFee: "100000" })).rejects.toThrow(/jito/);
    await expect(a.prepare(target, wallet, { jitoTip: "10000", maxTotalFee: "100000" })).resolves.toBeDefined();
  });

  it("puts the jito tip transfer inside the tx, before the buy", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    const msg = VersionedTransaction.deserialize((await a.prepare(target, wallet, { jitoTip: "10000" })).unsigned).message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const ixs = msg.compiledInstructions;
    const tipIx = ixs.findIndex((ix) => keys[ix.programIdIndex] === SystemProgram.programId.toBase58());
    expect(tipIx).toBeGreaterThanOrEqual(0);
    const to = keys[ixs[tipIx]!.accountKeyIndexes[1]!]!;
    expect(JITO_TIP_ACCOUNTS).toContain(to);
    // SystemProgram transfer data: u32 index 2, then u64 lamports.
    expect(Buffer.from(ixs[tipIx]!.data).readBigUInt64LE(4)).toBe(10_000n);
    const buyIx = ixs.findIndex((ix) => keys[ix.programIdIndex] === programId.toBase58());
    expect(tipIx).toBeLessThan(buyIx);
    // No tip unless asked for.
    const plain = VersionedTransaction.deserialize((await a.prepare(target, wallet, {})).unsigned).message;
    expect(plain.compiledInstructions.some((ix) => plain.staticAccountKeys[ix.programIdIndex]!.equals(SystemProgram.programId))).toBe(false);
  });

  it("requires explicit launchpads", () => {
    expect(() => new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [] })).toThrow(/LaunchpadDefinition/);
  });

  it("validates inputs", async () => {
    const a = new SolanaTokenAdapter({ connection: fakeConnection(curveData()), launchpads: [pump] });
    await expect(a.prepare({ ...target, spendPerWallet: "0" }, wallet, {})).rejects.toThrow(/spendPerWallet/);
    await expect(a.prepare({ ...target, spendPerWallet: "1.5" }, wallet, {})).rejects.toThrow(/spendPerWallet/);
    await expect(a.prepare({ ...target, slippageBps: 10_000 }, wallet, {})).rejects.toThrow(/slippageBps/);
    await expect(a.prepare({ ...target, spendPerWallet: (1n << 64n).toString() }, wallet, {})).rejects.toThrow(/spendPerWallet/);
    await expect(a.prepare(target, { ...wallet, family: "evm" }, {})).rejects.toThrow(/Solana/);
  });
});
