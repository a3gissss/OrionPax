// Pluggable launchpad definitions for bonding-curve token launches on Solana.
//
// A LaunchpadDefinition knows how to (1) find and decode a launch's on-chain
// state, (2) quote a buy for a given SOL spend, and (3) encode the buy
// instruction(s). The adapter handles everything chain-generic around that:
// RPC reads, ComputeBudget, the buyer's ATA, blockhash/message compilation and
// simulation. Add a new launchpad by implementing this interface.

import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const BPS_DENOMINATOR = 10_000n;

/** Decoded on-chain state of one bonding curve (one token launch). */
export interface CurveState {
  /** The curve account address. */
  curve: PublicKey;
  mint: PublicKey;
  /** True once the curve is sold out / migrated to an AMM: buys must be refused. */
  complete: boolean;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** Protocol fee charged on top of the SOL cost, in bps. */
  feeBps: bigint;
  /** Launchpad-specific extra data the instruction encoder needs (e.g. fee recipient). */
  extra: Record<string, PublicKey | bigint | boolean | string>;
}

export interface BuyQuote {
  /** Total lamports the caller wants to spend (fee included). */
  spend: bigint;
  /** Tokens (base units) expected at the current curve state. */
  expectedTokensOut: bigint;
  /** Lower bound on tokens received; enforced on-chain (equals expectedTokensOut for exact-out launchpads). */
  minTokensOut: bigint;
  /** Expected lamports paid (cost + fee) for expectedTokensOut at the current state. */
  expectedSolCost: bigint;
  /** Upper bound on lamports paid (cost + fee) after slippage. Enforced on-chain. MUST be <= spend. */
  maxSolCost: bigint;
  slippageBps: number;
}

export interface BuildBuyArgs {
  state: CurveState;
  user: PublicKey;
  /** The user's associated token account for the mint (created idempotently by the adapter). */
  userAta: PublicKey;
  tokenProgram: PublicKey;
  quote: BuyQuote;
}

export interface LaunchpadDefinition {
  /** Short stable id, surfaced as MintState.detectedStyle. */
  readonly id: string;
  readonly programId: PublicKey;
  /** Address of the curve account for a mint. */
  curveAddress(mint: PublicKey): PublicKey;
  /**
   * Additional accounts (besides the curve and the mint) that must be read to
   * decode state, e.g. a global config. Returned in a fixed order.
   */
  auxAccounts(mint: PublicKey): PublicKey[];
  /** Decode the curve + aux accounts. Throw if the data is not a valid curve for this launchpad. */
  decode(mint: PublicKey, curveData: Uint8Array, auxData: Array<Uint8Array | null>): CurveState;
  /** Quote a buy that spends `spend` lamports (fee included) with the given slippage tolerance. */
  quoteBuy(state: CurveState, spend: bigint, slippageBps: number): BuyQuote;
  /** Encode the buy instruction(s). ComputeBudget and ATA creation are added by the adapter. */
  buildBuy(args: BuildBuyArgs): TransactionInstruction[];
  /** Optional: map a program custom error code to a readable name. */
  errorName?(code: number): string | undefined;
}

/** Constant-product curve quote shared by pump.fun-style launchpads. */
export function constantProductTokensOut(vSol: bigint, vToken: bigint, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  return (vToken * solIn) / (vSol + solIn);
}

/** Lamports (before fee) the curve charges for exactly `tokens` out. Mirrors pump.fun's rounding (+1). */
export function constantProductSolCost(vSol: bigint, vToken: bigint, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  if (tokens >= vToken) throw new Error("tokens out exceeds virtual token reserves");
  return (tokens * vSol) / (vToken - tokens) + 1n;
}

export function applyBpsUp(x: bigint, bps: number): bigint {
  return (x * (BPS_DENOMINATOR + BigInt(bps))) / BPS_DENOMINATOR;
}

export function applyBpsDown(x: bigint, bps: number): bigint {
  return (x * (BPS_DENOMINATOR - BigInt(bps))) / BPS_DENOMINATOR;
}

export function feeOf(x: bigint, feeBps: bigint): bigint {
  return (x * feeBps) / BPS_DENOMINATOR;
}
