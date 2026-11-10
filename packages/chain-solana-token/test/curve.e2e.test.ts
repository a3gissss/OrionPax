// E2E: 10 wallets buy on a pump.fun-layout bonding curve on a LOCAL validator.
//
// Requires a local solana-test-validator (E2E_SOLANA_RPC / E2E_SOLANA_WS) and
// the fixture program built at test/fixture-program/pump_curve_fixture.so
// (see test/fixture-program/build.sh). All keys are throwaway, generated here.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { TokenLaunchTarget, WalletRef, WalletSigner } from "@mint-engine/core";
import {
  createAssociatedTokenAccountIdempotentIx, createPumpFunLaunchpad, getAssociatedTokenAddress, SolanaTokenAdapter,
  type LaunchpadDefinition,
} from "../src/index.js";
import {
  airdrop, connect, createCurveIx, createMint, deployProgram, initGlobalIx, mintToIx, RPC_URL, sendAndWait,
  setCompleteIx, tokenBalance, waitForRpc, waitForSignatures, WS_URL,
} from "./helpers/local-chain.js";

const SO_PATH = fileURLToPath(new URL("./fixture-program/pump_curve_fixture.so", import.meta.url));
const SOL = BigInt(LAMPORTS_PER_SOL);
const DECIMALS = 6;
const SUPPLY = 1_000_000_000_000_000n;
const CURVE = { vTok: 1_073_000_000_000_000n, vSol: 30n * SOL, realTok: 793_100_000_000_000n, supply: SUPPLY };

function keypairSigner(kp: Keypair, i: number): WalletSigner {
  const wallet: WalletRef = { id: `w${i + 1}`, label: `Wallet ${i + 1}`, family: "solana", address: kp.publicKey.toBase58() };
  return {
    wallet,
    async signTransaction(unsigned) {
      const tx = VersionedTransaction.deserialize(unsigned);
      tx.sign([kp]);
      return tx.serialize();
    },
  };
}

const conn = connect();
const admin = Keypair.generate();
const feeRecipient = Keypair.generate();
const whale = Keypair.generate();
const wallets = Array.from({ length: 10 }, () => Keypair.generate());
const signers = wallets.map(keypairSigner);
const whaleSigner = keypairSigner(whale, 99);

let programId: PublicKey;
let launchpad: LaunchpadDefinition;
let adapter: SolanaTokenAdapter;

async function launchToken(): Promise<PublicKey> {
  const mint = await createMint(conn, admin, DECIMALS);
  const curve = launchpad.curveAddress(mint.publicKey);
  const curveAta = getAssociatedTokenAddress(mint.publicKey, curve);
  await sendAndWait(conn, [
    createCurveIx(programId, admin.publicKey, mint.publicKey, curve, CURVE),
    createAssociatedTokenAccountIdempotentIx(admin.publicKey, curveAta, curve, mint.publicKey),
    mintToIx(mint.publicKey, curveAta, admin.publicKey, SUPPLY),
  ], [admin]);
  return mint.publicKey;
}

function targetFor(mint: PublicKey, spendLamports: bigint, slippageBps: number): TokenLaunchTarget {
  return {
    kind: "token", chain: "solana", tokenAddress: mint.toBase58(), launchpadAddress: programId.toBase58(),
    spendPerWallet: spendLamports.toString(), slippageBps,
  };
}

async function sendSigned(raw: Uint8Array[]): Promise<string[]> {
  return Promise.all(raw.map((r) => conn.sendRawTransaction(r, { skipPreflight: true, maxRetries: 5 })));
}

describe("solana token adapter e2e (local validator)", () => {
  beforeAll(async () => {
    if (!existsSync(SO_PATH)) throw new Error(`fixture program missing: ${SO_PATH} (run test/fixture-program/build.sh)`);
    await waitForRpc(conn);
    await airdrop(conn, [admin.publicKey, whale.publicKey], 100);
    await airdrop(conn, [feeRecipient.publicKey, ...wallets.map((w) => w.publicKey)], 5);
    programId = await deployProgram(conn, admin, SO_PATH);
    await sendAndWait(conn, [initGlobalIx(programId, admin.publicKey, feeRecipient.publicKey, 100n)], [admin]);
    launchpad = createPumpFunLaunchpad({ programId });
    adapter = new SolanaTokenAdapter({ config: { rpcUrl: RPC_URL, wsUrl: WS_URL }, launchpads: [launchpad] });
  }, 300_000);

  it("10 wallets buy concurrently; each gets >= minTokensOut and pays <= maxSolCost", async () => {
    const mint = await launchToken();
    const target = targetFor(mint, SOL / 10n, 500); // 0.1 SOL each, 5% slippage
    expect(adapter.supports(target)).toBe(true);

    const state = await adapter.detect(target);
    expect(state.live).toBe(true);
    expect(state.detectedStyle).toBe("pump-fun");
    expect(BigInt(state.pricePerUnit!)).toBeGreaterThan(0n);

    const fees = { priorityFee: "10000" };
    // base fee + priority fee (10_000 micro-lamports * 150k CU, rounded up).
    const networkFeeCap = 5_000n + 1_500n;
    const prepared = await adapter.prepareMany(target, signers.map((s) => s.wallet), fees);
    const signed = await Promise.all(prepared.map((p, i) => signers[i]!.signTransaction(p.unsigned)));

    const sims = await Promise.all(prepared.map((p, i) => adapter.simulate(p, signed[i])));
    sims.forEach((s) => expect(s.ok, s.error).toBe(true));
    const unsignedSim = await adapter.simulate(prepared[0]!);
    expect(unsignedSim.ok, unsignedSim.error).toBe(true);

    const before = await Promise.all(wallets.map((w) => conn.getBalance(w.publicKey, "confirmed")));
    const sigs = await sendSigned(signed);
    expect(new Set(sigs).size).toBe(10);
    const statuses = await waitForSignatures(conn, sigs);

    for (let i = 0; i < 10; i++) {
      const sig = sigs[i]!;
      const st = statuses.get(sig)!;
      expect(st.err, `wallet ${i + 1} tx ${sig}`).toBeNull();
      // Each signature belongs to a landed tx paid and signed by that wallet.
      const landed = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      expect(landed?.transaction.signatures[0]).toBe(sig);
      expect(landed?.transaction.message.staticAccountKeys[0]!.toBase58()).toBe(wallets[i]!.publicKey.toBase58());
      const bal = await tokenBalance(conn, getAssociatedTokenAddress(mint, wallets[i]!.publicKey));
      // Exact-out buy: each wallet receives exactly its quoted amount, i.e. >= minTokensOut.
      expect(bal).toBeGreaterThan(0n);
      expect(bal).toBeGreaterThanOrEqual(prepared[i]!.quote.minTokensOut);
      expect(bal).toBe(prepared[i]!.quote.expectedTokensOut);
      const after = await conn.getBalance(wallets[i]!.publicKey, "confirmed");
      const spent = BigInt(before[i]! - after);
      // SOL out = curve cost + fee (<= maxSolCost <= spendPerWallet) + ATA rent + network fees.
      expect(prepared[i]!.quote.maxSolCost).toBeLessThanOrEqual(BigInt(target.spendPerWallet));
      expect(spent).toBeLessThanOrEqual(BigInt(prepared[i]!.value) + networkFeeCap);
    }
  }, 180_000);

  it("slippage guard trips when the price moves between prepare and send", async () => {
    const mint = await launchToken();
    const tight = targetFor(mint, SOL / 10n, 100); // 1%
    const victim = signers[0]!;
    const prepared = await adapter.prepare(tight, victim.wallet, {});
    const signed = await victim.signTransaction(prepared.unsigned);
    expect((await adapter.simulate(prepared, signed)).ok).toBe(true);

    // A large buy moves the price far more than 1%.
    const big = await adapter.prepare(targetFor(mint, 10n * SOL, 500), whaleSigner.wallet, {});
    const [bigSig] = await sendSigned([await whaleSigner.signTransaction(big.unsigned)]);
    expect((await waitForSignatures(conn, [bigSig!])).get(bigSig!)!.err).toBeNull();

    const sim = await adapter.simulate(prepared, signed);
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/TooMuchSolRequired/);

    const [sig] = await sendSigned([signed]);
    const st = (await waitForSignatures(conn, [sig!])).get(sig!)!;
    expect(JSON.stringify(st.err)).toContain("6002");
    expect(await tokenBalance(conn, getAssociatedTokenAddress(mint, wallets[0]!.publicKey))).toBe(0n);

    // Re-preparing at the new price succeeds.
    const fresh = await adapter.prepare(tight, victim.wallet, {});
    expect(fresh.quote.expectedTokensOut).toBeLessThan(prepared.quote.expectedTokensOut);
    expect((await adapter.simulate(fresh, await victim.signTransaction(fresh.unsigned))).ok).toBe(true);
  }, 120_000);

  it("refuses to prepare once the curve is complete", async () => {
    const mint = await launchToken();
    await sendAndWait(conn, [setCompleteIx(programId, admin.publicKey, launchpad.curveAddress(mint))], [admin]);
    const target = targetFor(mint, SOL / 10n, 500);
    const state = await adapter.detect(target);
    expect(state.live).toBe(false);
    expect(state.detectedStyle).toBe("pump-fun:complete");
    await expect(adapter.prepare(target, signers[0]!.wallet, {})).rejects.toThrow(/complete/);
  }, 60_000);
});
