// Priority-fee estimation from getRecentPrioritizationFees, capped by FeeStrategy.maxTotalFee.

import { address, type Address, type GetRecentPrioritizationFeesApi, type Rpc } from "@solana/kit";
import type { FeeStrategy } from "@mint-engine/core";

/** Base fee per signature, in lamports. */
export const LAMPORTS_PER_SIGNATURE = 5000n;
/** Default CU budget assumed when the caller doesn't know the tx's compute limit. */
export const DEFAULT_COMPUTE_UNITS = 200_000;

export interface PriorityFeeEstimate {
  /** Value for SetComputeUnitPrice (micro-lamports per CU), after the cap. */
  microLamportsPerCu: bigint;
  /** Percentile value before the cap. */
  uncapped: bigint;
  capped: boolean;
  /** Number of recent-slot samples used. */
  samples: number;
}

export interface EstimatePriorityFeeOptions {
  /** Supplies maxTotalFee (cap) and jitoTip (counted against the cap). */
  fees?: FeeStrategy;
  /** CU limit the tx will request (SetComputeUnitLimit). Default 200k. */
  computeUnits?: number;
  /** Signatures in the tx (base fee 5000 lamports each). Default 1. */
  signatures?: number;
  /** Lower bound applied before the cap, e.g. 1 to always pay something. Default 0. */
  minMicroLamports?: bigint;
}

/** Nearest-rank percentile over unsorted values. p is clamped to [0,100]. */
export function percentileOf(values: readonly bigint[], p: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.max(1, Math.ceil((clamped / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/**
 * Highest micro-lamports/CU price that keeps base fee + priority fee + Jito tip at or under
 * `maxTotalFee`. Returns undefined when no cap is configured.
 */
export function maxPriceUnderCap(fees: FeeStrategy | undefined, computeUnits: number, signatures: number): bigint | undefined {
  if (!fees?.maxTotalFee) return undefined;
  const budget = BigInt(fees.maxTotalFee) - LAMPORTS_PER_SIGNATURE * BigInt(signatures) - BigInt(fees.jitoTip ?? "0");
  if (budget <= 0n || computeUnits <= 0) return 0n;
  // priorityLamports = ceil(price * CU / 1e6). Keep it <= budget.
  return (budget * 1_000_000n) / BigInt(computeUnits);
}

/**
 * Estimate a priority fee from the given percentile of recent prioritization fees paid by
 * txs that write-lock `accounts` (e.g. the Candy Machine / bonding curve). Capped so the
 * total fee never exceeds `fees.maxTotalFee`.
 */
export async function estimatePriorityFee(
  rpc: Pick<Rpc<GetRecentPrioritizationFeesApi>, "getRecentPrioritizationFees">,
  accounts: ReadonlyArray<string>,
  percentile: number,
  opts: EstimatePriorityFeeOptions = {},
): Promise<PriorityFeeEstimate> {
  const addrs: Address[] = accounts.slice(0, 128).map((a) => address(a));
  const recent = await rpc.getRecentPrioritizationFees(addrs.length ? addrs : undefined).send();
  const values = recent.map((r) => BigInt(r.prioritizationFee));
  let fee = percentileOf(values, percentile);
  const min = opts.minMicroLamports ?? 0n;
  if (fee < min) fee = min;
  const cap = maxPriceUnderCap(opts.fees, opts.computeUnits ?? DEFAULT_COMPUTE_UNITS, opts.signatures ?? 1);
  const capped = cap !== undefined && fee > cap;
  return { microLamportsPerCu: capped ? cap : fee, uncapped: fee, capped, samples: values.length };
}
