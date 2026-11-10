// Solana NFT adapter for Metaplex Core Candy Machine (+ Core Candy Guard).
//
// Transaction format returned by `prepare` (PreparedTx.unsigned):
//   A full serialized Solana wire transaction (v0 message), *partially signed*.
//   Each mint instruction creates a new Core asset whose address must sign the tx.
//   We generate a fresh asset keypair per unit in memory, sign the tx with it, and
//   discard the secret key. The fee-payer / minter signature slot (index 0, the
//   wallet) is left zeroed. The wallet signer must add its own signature while
//   keeping the existing asset signature(s), e.g. with @solana/web3.js:
//     const tx = VersionedTransaction.deserialize(unsigned); tx.sign([walletKeypair]);
//   The resulting bytes are ready for sendTransaction.

import type {
  ChainAdapter, ChainConfig, FeeStrategy, MintState, MintTarget, NftMintTarget,
  PreparedTx, SimulationResult, WalletRef,
} from "@mint-engine/core";
import {
  createNoopSigner, generateSigner, publicKey as toPublicKey, signTransaction,
  some, transactionBuilder, type PublicKey, type Signer, type TransactionBuilder, type Umi,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base64 } from "@metaplex-foundation/umi/serializers";
import {
  fetchCandyGuard, fetchCandyMachine, findMintCounterPda, mintV1, mplCandyMachine,
  safeFetchMintCounter, type CandyGuard, type CandyMachine, type DefaultGuardSetMintArgs,
} from "@metaplex-foundation/mpl-core-candy-machine";
import { mplCore } from "@metaplex-foundation/mpl-core";
import { setComputeUnitLimit, setComputeUnitPrice } from "@metaplex-foundation/mpl-toolbox";
import {
  REFUSED_GUARDS, computeUnitLimit, parsePriorityFee, priorityFeeLamports, summarizeGuards,
  type GuardSetLike, type GuardSummary,
} from "./guards.js";

export const CORE_CANDY_MACHINE_PROGRAM_ID = "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J";
export const CORE_CANDY_GUARD_PROGRAM_ID = "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ";

export interface SolanaNftAdapterOptions {
  /** Pre-built umi instance (tests). Otherwise one is created from `config.rpcUrl`. */
  umi?: Umi;
  /** CU limit per mint used when simulation fails (e.g. mint not live yet). */
  fallbackComputeUnitsPerMint?: number;
  /** Margin over simulated CU, basis points (default 1000 = 10%). */
  computeMarginBps?: number;
  /** Clock override for tests; Unix ms. */
  now?: () => number;
}

interface LoadedMachine {
  cm: CandyMachine;
  guard: CandyGuard;
  summary: GuardSummary;
}

const SIM_CU_LIMIT = 1_400_000;
const MAX_CU_LIMIT = 1_400_000;
const BOT_TAX_LOG = /botting|bot tax/i;

function remainingSupply(cm: CandyMachine, summary: GuardSummary): number {
  let remaining = cm.data.itemsAvailable - cm.itemsRedeemed;
  if (summary.redeemedAmountMax !== undefined) {
    const capLeft = summary.redeemedAmountMax - cm.itemsRedeemed;
    if (capLeft < remaining) remaining = capLeft;
  }
  return Math.max(0, Number(remaining));
}

export class SolanaCoreCandyMachineAdapter implements ChainAdapter {
  readonly chain = "solana" as const;
  readonly kind = "nft" as const;
  readonly umi: Umi;
  private readonly fallbackCu: number;
  private readonly marginBps: number;
  private readonly now: () => number;

  constructor(config: Pick<ChainConfig, "rpcUrl"> | undefined, opts: SolanaNftAdapterOptions = {}) {
    if (!opts.umi && !config) throw new Error("SolanaCoreCandyMachineAdapter needs a ChainConfig or a umi instance");
    const umi = opts.umi ?? createUmi(config!.rpcUrl, { commitment: "confirmed" });
    this.umi = umi.use(mplCore()).use(mplCandyMachine());
    this.fallbackCu = opts.fallbackComputeUnitsPerMint ?? 250_000;
    this.marginBps = opts.computeMarginBps ?? 1_000;
    this.now = opts.now ?? Date.now;
  }

  supports(target: MintTarget): boolean {
    return target.kind === "nft" && target.chain === "solana"
      && (target.style === undefined || target.style === "core-candy-machine");
  }

  private asNft(target: MintTarget): NftMintTarget {
    if (!this.supports(target)) throw new Error("target is not a Solana Core Candy Machine NFT mint");
    return target as NftMintTarget;
  }

  private async load(address: string): Promise<LoadedMachine> {
    const cmKey = toPublicKey(address);
    const cm = await fetchCandyMachine(this.umi, cmKey);
    if (cm.header.owner !== CORE_CANDY_MACHINE_PROGRAM_ID) {
      throw new Error(`account ${address} is not owned by the Core Candy Machine program`);
    }
    // The candy guard wraps the machine by becoming its mint authority.
    const guard = await fetchCandyGuard(this.umi, cm.mintAuthority);
    if (guard.header.owner !== CORE_CANDY_GUARD_PROGRAM_ID) {
      throw new Error(`mint authority ${cm.mintAuthority} is not a Core Candy Guard`);
    }
    const summary = summarizeGuards(guard.guards as unknown as GuardSetLike);
    return { cm, guard, summary };
  }

  async detect(target: MintTarget): Promise<MintState> {
    const t = this.asNft(target);
    const { cm, guard, summary } = await this.load(t.address);
    const remaining = remainingSupply(cm, summary);
    const now = this.now();
    // Guard groups are not supported (no group selection in NftMintTarget), so report not-live.
    const live = remaining > 0
      && guard.groups.length === 0
      && (summary.startsAt === undefined || now >= summary.startsAt)
      && (summary.endsAt === undefined || now < summary.endsAt);
    const state: MintState = {
      live,
      pricePerUnit: summary.priceLamports,
      remainingSupply: remaining,
      detectedStyle: "core-candy-machine",
    };
    if (summary.startsAt !== undefined) state.startsAt = summary.startsAt;
    if (summary.mintLimit) state.maxPerWallet = summary.mintLimit.limit;
    return state;
  }

  /** Number of units this wallet has already minted under the mintLimit guard (0 if none). */
  async mintedByWallet(target: MintTarget, wallet: WalletRef): Promise<number> {
    const t = this.asNft(target);
    const { cm, summary } = await this.load(t.address);
    if (!summary.mintLimit) return 0;
    return this.readMintCounter(cm, summary.mintLimit.id, toPublicKey(wallet.address));
  }

  private async readMintCounter(cm: CandyMachine, id: number, user: PublicKey): Promise<number> {
    const pda = findMintCounterPda(this.umi, { id, user, candyMachine: cm.publicKey, candyGuard: cm.mintAuthority });
    const counter = await safeFetchMintCounter(this.umi, pda);
    return counter ? counter.count : 0;
  }

  async prepare(target: MintTarget, wallet: WalletRef, fees: FeeStrategy): Promise<PreparedTx> {
    const t = this.asNft(target);
    if (wallet.family !== "solana") throw new Error(`wallet ${wallet.id} is not a Solana wallet`);
    if (!Number.isInteger(t.quantity) || t.quantity < 1) throw new Error(`invalid quantity ${t.quantity}`);
    const microLamports = parsePriorityFee(fees.priorityFee);

    const { cm, guard, summary } = await this.load(t.address);
    if (guard.groups.length > 0) {
      throw new Error("candy guard uses guard groups; group selection is not supported by this adapter");
    }
    const refused = summary.unsupported.filter((g) => REFUSED_GUARDS.has(g));
    if (refused.length) throw new Error(`mint requires guard(s) this tool will not handle: ${refused.join(", ")}`);
    if (summary.unsupported.length) throw new Error(`unsupported guard(s): ${summary.unsupported.join(", ")}`);

    const remaining = remainingSupply(cm, summary);
    if (t.quantity > remaining) throw new Error(`quantity ${t.quantity} exceeds remaining supply ${remaining}`);

    if (summary.botTax && t.quantity > 1) {
      // botTax charges (instead of failing) any mint that is not the tx's last instruction.
      throw new Error("botTax guard is set; only quantity 1 per transaction is safe");
    }

    const user = toPublicKey(wallet.address);
    if (summary.addressGate && summary.addressGate !== user) {
      throw new Error(`addressGate restricts minting to ${summary.addressGate}`);
    }
    if (summary.mintLimit) {
      const { id, limit } = summary.mintLimit;
      if (t.quantity > limit) throw new Error(`quantity ${t.quantity} exceeds the guard's mintLimit of ${limit} per wallet`);
      const already = await this.readMintCounter(cm, id, user);
      if (already + t.quantity > limit) {
        throw new Error(`wallet ${wallet.id} already minted ${already}/${limit}; mintLimit reached`);
      }
    }

    const walletSigner = createNoopSigner(user);
    const assets: Signer[] = Array.from({ length: t.quantity }, () => generateSigner(this.umi));
    const mintArgs: Partial<DefaultGuardSetMintArgs> = {};
    if (summary.solPaymentDestination) mintArgs.solPayment = some({ destination: summary.solPaymentDestination });
    if (summary.mintLimit) mintArgs.mintLimit = some({ id: summary.mintLimit.id });

    let mints = transactionBuilder();
    for (const asset of assets) {
      mints = mints.add(mintV1(this.umi, {
        candyMachine: cm.publicKey,
        candyGuard: cm.mintAuthority,
        collection: cm.collectionMint,
        asset,
        minter: walletSigner,
        payer: walletSigner,
        mintArgs,
      }));
    }

    const withBudget = (units: number): TransactionBuilder => {
      let b = transactionBuilder().add(setComputeUnitLimit(this.umi, { units }));
      if (microLamports > 0n) b = b.add(setComputeUnitPrice(this.umi, { microLamports }));
      return b.add(mints).setFeePayer(walletSigner);
    };

    const blockhash = await this.umi.rpc.getLatestBlockhash({ commitment: "confirmed" });

    // 1) Simulate with a generous CU limit to measure usage.
    const probe = withBudget(SIM_CU_LIMIT).setBlockhash(blockhash);
    if (!probe.fitsInOneTransaction(this.umi)) {
      throw new Error(`quantity ${t.quantity} does not fit in one transaction; use a lower quantity`);
    }
    const probeTx = await signTransaction(probe.build(this.umi), assets);
    const sim = await this.simulateBytes(this.umi.transactions.serialize(probeTx));
    const cuLimit = sim.ok && sim.computeOrGasUsed
      ? computeUnitLimit(sim.computeOrGasUsed, this.marginBps)
      : Math.min(this.fallbackCu * t.quantity, MAX_CU_LIMIT);

    const maxTotalFee = fees.maxTotalFee !== undefined ? parsePriorityFee(fees.maxTotalFee) : undefined;
    const networkFee = 5_000n * BigInt(1 + assets.length) + priorityFeeLamports(cuLimit, microLamports);
    if (maxTotalFee !== undefined && networkFee > maxTotalFee) {
      throw new Error(`fee ${networkFee} lamports (base + priority at CU ${cuLimit}) exceeds maxTotalFee ${maxTotalFee}`);
    }

    // 2) Final tx with the measured CU limit, partially signed by the asset keypair(s).
    const finalTx = await signTransaction(withBudget(cuLimit).setBlockhash(blockhash).build(this.umi), assets);
    const unsigned = this.umi.transactions.serialize(finalTx);

    const value = (BigInt(summary.priceLamports) * BigInt(t.quantity)).toString();
    return {
      chain: "solana",
      walletId: wallet.id,
      unsigned,
      value,
      computeOrGas: cuLimit,
      validUntil: blockhash.lastValidBlockHeight,
      description: `Core Candy Machine mint x${t.quantity} from ${cm.publicKey} for ${wallet.label}`
        + ` (assets ${assets.map((a) => a.publicKey).join(", ")}; ${value} lamports; CU ${cuLimit}`
        + `${sim.ok ? "" : ", CU from fallback: simulation failed"})`,
    };
  }

  /**
   * simulateTransaction with sigVerify:false. A signed tx is simulated with its own blockhash
   * (so expiry shows up as BlockhashNotFound); an unsigned/partially-signed one gets a fresh blockhash.
   */
  async simulate(tx: PreparedTx, signedTx?: Uint8Array): Promise<SimulationResult> {
    return this.simulateBytes(signedTx ?? tx.unsigned, signedTx === undefined);
  }

  private async simulateBytes(bytes: Uint8Array, replaceRecentBlockhash = true): Promise<SimulationResult> {
    type SimResponse = { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } };
    try {
      const encoded = base64.deserialize(bytes)[0];
      const res = await this.umi.rpc.call<SimResponse | undefined>("simulateTransaction", [
        encoded,
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash, commitment: "confirmed" },
      ]);
      // The web3.js-backed RPC resolves `response.result`, which is undefined on a JSON-RPC error.
      if (!res?.value) return { ok: false, error: "simulateTransaction returned no result (RPC error)" };
      const v = res.value;
      const out: SimulationResult = { ok: v.err === null || v.err === undefined, logs: v.logs ?? [] };
      if (v.unitsConsumed !== undefined) out.computeOrGasUsed = v.unitsConsumed;
      if (!out.ok) out.error = typeof v.err === "string" ? v.err : JSON.stringify(v.err);
      // botTax turns a failed guard check into a successful tx that only charges the tax.
      if (out.ok && out.logs!.some((l) => BOT_TAX_LOG.test(l))) {
        out.ok = false;
        out.error = "candy guard bot tax would be charged (a guard check failed)";
      }
      return out;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function createSolanaNftAdapter(config: ChainConfig, opts?: SolanaNftAdapterOptions): SolanaCoreCandyMachineAdapter {
  return new SolanaCoreCandyMachineAdapter(config, opts);
}
