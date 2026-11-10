// ChainAdapter for Solana bonding-curve token launches (pump.fun-style).

import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type Commitment, type TransactionInstruction,
} from "@solana/web3.js";
import { pickJitoTipAccount } from "@mint-engine/core";
import type {
  ChainAdapter, ChainConfig, FeeStrategy, MintState, MintTarget, PreparedTx, SimulationResult,
  TokenLaunchTarget, WalletRef,
} from "@mint-engine/core";
import {
  createAssociatedTokenAccountIdempotentIx, decodeMintDecimals, getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "./ata.js";
import type { BuyQuote, CurveState, LaunchpadDefinition } from "./launchpad.js";

export const DEFAULT_COMPUTE_UNIT_LIMIT = 150_000;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const U64_MAX = (1n << 64n) - 1n;
/** Base fee per signature, lamports. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

export interface SolanaTokenAdapterOptions {
  /** RPC endpoint (or a full ChainConfig). Ignored when `connection` is given. */
  config?: Pick<ChainConfig, "rpcUrl" | "wsUrl">;
  connection?: Connection;
  /**
   * Launchpads this adapter can trade on (required; there is deliberately no
   * default, because live launchpads change their instruction layouts).
   */
  launchpads: LaunchpadDefinition[];
  computeUnitLimit?: number;
  commitment?: Commitment;
}

/** Everything `detect` learns, also used by `prepare`. */
export interface LaunchSnapshot {
  launchpad: LaunchpadDefinition;
  state: CurveState;
  tokenProgram: PublicKey;
  decimals: number;
}

export interface PreparedBuy extends PreparedTx {
  quote: BuyQuote;
}

function isTokenTarget(t: MintTarget): t is TokenLaunchTarget {
  return t.kind === "token";
}

function parsePubkey(value: string, what: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`invalid ${what}: ${value}`);
  }
}

function parseLamports(value: string | undefined, what: string): bigint | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${what}: ${value} (expected a non-negative integer string)`);
  return BigInt(value);
}

export class SolanaTokenAdapter implements ChainAdapter {
  readonly chain = "solana" as const;
  readonly kind = "token" as const;
  readonly connection: Connection;
  readonly launchpads: LaunchpadDefinition[];
  private readonly computeUnitLimit: number;
  private readonly commitment: Commitment;
  private readonly rentCache = new Map<number, bigint>();

  constructor(opts: SolanaTokenAdapterOptions) {
    this.commitment = opts.commitment ?? "confirmed";
    if (opts.connection) {
      this.connection = opts.connection;
    } else if (opts.config) {
      this.connection = new Connection(opts.config.rpcUrl, {
        commitment: this.commitment,
        ...(opts.config.wsUrl ? { wsEndpoint: opts.config.wsUrl } : {}),
      });
    } else {
      throw new Error("SolanaTokenAdapter needs either `connection` or `config.rpcUrl`");
    }
    if (!opts.launchpads || opts.launchpads.length === 0) {
      throw new Error("SolanaTokenAdapter needs at least one LaunchpadDefinition (e.g. createPumpFunLaunchpad({ programId }))");
    }
    this.launchpads = opts.launchpads;
    this.computeUnitLimit = opts.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
    if (!Number.isInteger(this.computeUnitLimit) || this.computeUnitLimit <= 0 || this.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
      throw new Error(`computeUnitLimit must be an integer in (0, ${MAX_COMPUTE_UNIT_LIMIT}]`);
    }
  }

  private launchpadFor(target: TokenLaunchTarget): LaunchpadDefinition | undefined {
    return this.launchpads.find((l) => l.programId.toBase58() === target.launchpadAddress);
  }

  supports(target: MintTarget): boolean {
    return target.chain === "solana" && isTokenTarget(target) && this.launchpadFor(target) !== undefined;
  }

  private requireTarget(target: MintTarget): { target: TokenLaunchTarget; launchpad: LaunchpadDefinition } {
    if (target.chain !== "solana" || !isTokenTarget(target)) {
      throw new Error(`SolanaTokenAdapter cannot handle ${target.chain}/${target.kind} targets`);
    }
    const launchpad = this.launchpadFor(target);
    if (!launchpad) throw new Error(`no launchpad definition registered for program ${target.launchpadAddress}`);
    return { target, launchpad };
  }

  /** Read and decode the curve, mint and launchpad aux accounts in a single RPC round trip. */
  async snapshot(mintTarget: MintTarget): Promise<LaunchSnapshot> {
    const { target, launchpad } = this.requireTarget(mintTarget);
    const mint = parsePubkey(target.tokenAddress, "token mint");
    const curve = launchpad.curveAddress(mint);
    const aux = launchpad.auxAccounts(mint);
    const infos = await this.connection.getMultipleAccountsInfo([curve, mint, ...aux], this.commitment);
    const [curveInfo, mintInfo, ...auxInfos] = infos;
    if (!curveInfo) throw new Error(`bonding curve ${curve.toBase58()} not found for mint ${mint.toBase58()}`);
    if (!curveInfo.owner.equals(launchpad.programId)) {
      throw new Error(`curve ${curve.toBase58()} is not owned by launchpad program ${launchpad.programId.toBase58()}`);
    }
    if (!mintInfo) throw new Error(`token mint ${mint.toBase58()} not found`);
    const tokenProgram = mintInfo.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`${mint.toBase58()} is not an SPL token mint (owner ${tokenProgram.toBase58()})`);
    }
    const state = launchpad.decode(mint, curveInfo.data, auxInfos.map((i) => i?.data ?? null));
    return { launchpad, state, tokenProgram, decimals: decodeMintDecimals(mintInfo.data) };
  }

  async detect(target: MintTarget): Promise<MintState> {
    const { launchpad, state, decimals } = await this.snapshot(target);
    const unit = 10n ** BigInt(decimals);
    // Spot price (fee excluded) in lamports per WHOLE token (10^decimals base units), floored.
    // Per-base-unit prices on pump-style curves are fractions of a lamport and would floor to 0.
    const price = state.virtualTokenReserves > 0n ? (state.virtualSolReserves * unit) / state.virtualTokenReserves : 0n;
    return {
      live: !state.complete && state.realTokenReserves > 0n,
      pricePerUnit: price.toString(),
      remainingSupply: Number(state.realTokenReserves / unit),
      detectedStyle: state.complete ? `${launchpad.id}:complete` : launchpad.id,
    };
  }

  async prepare(mintTarget: MintTarget, wallet: WalletRef, fees: FeeStrategy): Promise<PreparedBuy> {
    const [tx] = await this.prepareMany(mintTarget, [wallet], fees);
    return tx!;
  }

  /**
   * Prepare buys for several wallets against ONE curve snapshot and blockhash
   * (3 RPC round trips total, in parallel, instead of 2 per wallet).
   * Every wallet's quote is computed at the same price; buys landing later see
   * a higher price, which the per-wallet maxSolCost/slippage absorbs or rejects.
   */
  async prepareMany(mintTarget: MintTarget, wallets: WalletRef[], fees: FeeStrategy): Promise<PreparedBuy[]> {
    const { target } = this.requireTarget(mintTarget);
    const users = wallets.map((w) => {
      if (w.family !== "solana") throw new Error(`wallet ${w.id} is not a Solana wallet`);
      return parsePubkey(w.address, `address of wallet ${w.id}`);
    });
    const spend = parseLamports(target.spendPerWallet, "spendPerWallet");
    if (spend === undefined || spend <= 0n || spend > U64_MAX) {
      throw new Error("spendPerWallet must be a lamport amount in (0, 2^64)");
    }
    if (!Number.isInteger(target.slippageBps) || target.slippageBps < 0 || target.slippageBps >= 10_000) {
      throw new Error(`slippageBps must be an integer in [0, 10000), got ${target.slippageBps}`);
    }
    const microLamports = parseLamports(fees.priorityFee, "priorityFee") ?? 0n;
    if (microLamports > U64_MAX) throw new Error("priorityFee exceeds u64");
    const maxTotalFee = parseLamports(fees.maxTotalFee, "maxTotalFee");
    // Jito tip: a transfer to a tip account inside the signed tx (added below), counted toward the cap.
    const jitoTip = parseLamports(fees.jitoTip, "jitoTip") ?? 0n;
    const priorityLamports = (microLamports * BigInt(this.computeUnitLimit) + 999_999n) / 1_000_000n;
    const totalFee = LAMPORTS_PER_SIGNATURE + priorityLamports + jitoTip;
    if (maxTotalFee !== undefined && totalFee > maxTotalFee) {
      throw new Error(`fee ${totalFee} lamports (base + priority + jito tip) exceeds maxTotalFee ${maxTotalFee}`);
    }
    if (wallets.length === 0) return [];

    const snap = await this.snapshot(target);
    const { launchpad, state, tokenProgram } = snap;
    if (state.complete) {
      throw new Error(`bonding curve for ${target.tokenAddress} is complete (migrated); refusing to buy`);
    }
    if (state.realTokenReserves <= 0n) throw new Error(`bonding curve for ${target.tokenAddress} has no tokens left`);

    const quote = launchpad.quoteBuy(state, spend, target.slippageBps);
    if (quote.minTokensOut <= 0n) throw new Error(`spend of ${spend} lamports buys 0 tokens at current price`);
    if (quote.maxSolCost > spend) throw new Error(`launchpad ${launchpad.id} quoted maxSolCost above spendPerWallet`);

    const atas = users.map((u) => getAssociatedTokenAddress(state.mint, u, tokenProgram));
    const [latest, ataInfos, ataRent] = await Promise.all([
      this.connection.getLatestBlockhash(this.commitment),
      this.connection.getMultipleAccountsInfo(atas, this.commitment),
      this.ataRent(tokenProgram),
    ]);

    return wallets.map((wallet, i) => {
      const user = users[i]!;
      const userAta = atas[i]!;
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
      ];
      if (microLamports > 0n) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
      if (jitoTip > 0n) {
        ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(pickJitoTipAccount()), lamports: jitoTip }));
      }
      ixs.push(createAssociatedTokenAccountIdempotentIx(user, userAta, user, state.mint, tokenProgram));
      ixs.push(...launchpad.buildBuy({ state, user, userAta, tokenProgram, quote }));

      const message = new TransactionMessage({
        payerKey: user,
        recentBlockhash: latest.blockhash,
        instructions: ixs,
      }).compileToV0Message();
      // SOL leaving the wallet besides fees: curve cost cap + ATA rent if the ATA is created here.
      const value = quote.maxSolCost + (ataInfos[i] ? 0n : ataRent);

      return {
        chain: "solana",
        walletId: wallet.id,
        // Wire-format VersionedTransaction with an empty (zeroed) signature slot.
        unsigned: new VersionedTransaction(message).serialize(),
        value: value.toString(),
        computeOrGas: this.computeUnitLimit,
        validUntil: latest.lastValidBlockHeight,
        description:
          `${launchpad.id} buy >= ${quote.minTokensOut} base units of ${state.mint.toBase58()} ` +
          `for <= ${quote.maxSolCost} lamports by ${wallet.label}`,
        quote,
      };
    });
  }

  private async ataRent(tokenProgram: PublicKey): Promise<bigint> {
    // Token-2022 ATAs carry the ImmutableOwner extension (170 bytes); classic SPL ATAs are 165 bytes.
    const size = tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165;
    let cached = this.rentCache.get(size);
    if (cached === undefined) {
      cached = BigInt(await this.connection.getMinimumBalanceForRentExemption(size));
      this.rentCache.set(size, cached);
    }
    return cached;
  }

  async simulate(tx: PreparedTx, signedTx?: Uint8Array): Promise<SimulationResult> {
    let vtx: VersionedTransaction;
    try {
      vtx = VersionedTransaction.deserialize(signedTx ?? tx.unsigned);
    } catch (e) {
      return { ok: false, error: `cannot deserialize transaction: ${(e as Error).message}` };
    }
    try {
      const res = await this.connection.simulateTransaction(vtx, {
        sigVerify: signedTx !== undefined,
        // Unsigned txs may carry a stale blockhash by the time they are simulated.
        replaceRecentBlockhash: signedTx === undefined,
        commitment: "processed",
      });
      const { err, logs, unitsConsumed } = res.value;
      const out: SimulationResult = { ok: err === null };
      if (unitsConsumed !== undefined) out.computeOrGasUsed = unitsConsumed;
      if (logs) out.logs = logs;
      if (err !== null) out.error = this.describeError(err, vtx);
      return out;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Name launchpad custom errors (e.g. TooMuchSolRequired) using the program that raised them. */
  private describeError(err: unknown, vtx: VersionedTransaction): string {
    const raw = JSON.stringify(err);
    const ie = (err as { InstructionError?: [number, { Custom?: number } | string] } | null)?.InstructionError;
    const detail = ie?.[1];
    const code = typeof detail === "object" && detail !== null ? detail.Custom : undefined;
    if (ie && code !== undefined) {
      const ix = vtx.message.compiledInstructions[ie[0]];
      const program = ix ? vtx.message.staticAccountKeys[ix.programIdIndex] : undefined;
      const launchpad = program ? this.launchpads.find((l) => l.programId.equals(program)) : undefined;
      const name = launchpad?.errorName?.(code);
      if (name) return `${name} (${code}): ${raw}`;
    }
    return raw;
  }
}
