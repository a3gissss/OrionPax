import { CHAIN_FAMILY } from "@mint-engine/core";
import type { FeeStrategy, PreparedTx, SimulationResult } from "@mint-engine/core";

/** Solana base fee per signature, lamports. */
export const SOLANA_BASE_FEE_LAMPORTS = 5000n;
/** Solana default compute-unit limit when nothing better is known. */
export const SOLANA_DEFAULT_CU = 200_000;

const big = (v: string | undefined): bigint | undefined => {
  if (v === undefined || v === "") return undefined;
  try { return BigInt(v); } catch { return undefined; }
};

/**
 * Worst-case total fee (base units) the tx can spend, or `undefined` if it cannot be bounded
 * from the information available. The engine fails closed when a cap is set and this is undefined.
 *
 * - EVM: gas limit (`computeOrGas`) × maxFeePerGas: the most the sender can be charged, native
 *   value excluded. Simulated gas *used* is not a bound, so without a gas limit this returns undefined.
 *   Note: OP-stack L1 data fees (Base) are not part of this bound; inject `estimateTotalFee` to add them.
 * - Solana: base fee (1 signature) + ceil(priorityFee µlamports/CU × CU / 1e6) + Jito tip.
 */
export function estimateMaxTotalFee(tx: PreparedTx, fees: FeeStrategy, sim?: SimulationResult): bigint | undefined {
  if (CHAIN_FAMILY[tx.chain] === "evm") {
    const maxFee = big(fees.maxFee);
    if (tx.computeOrGas === undefined || maxFee === undefined) return undefined;
    return BigInt(Math.ceil(tx.computeOrGas)) * maxFee;
  }
  const units = tx.computeOrGas ?? sim?.computeOrGasUsed;
  const cu = BigInt(Math.ceil(units ?? SOLANA_DEFAULT_CU));
  const prio = big(fees.priorityFee) ?? 0n;
  const tip = big(fees.jitoTip) ?? 0n;
  return SOLANA_BASE_FEE_LAMPORTS + (prio * cu + 999_999n) / 1_000_000n + tip;
}

/** Returns an error string if the tx would exceed `fees.maxTotalFee`, else undefined. */
export function checkFeeCap(
  tx: PreparedTx, fees: FeeStrategy, sim: SimulationResult | undefined,
  estimate: typeof estimateMaxTotalFee = estimateMaxTotalFee,
): string | undefined {
  if (fees.maxTotalFee === undefined || fees.maxTotalFee === "") return undefined;
  const cap = big(fees.maxTotalFee);
  if (cap === undefined) return `invalid maxTotalFee "${fees.maxTotalFee}"`;
  const est = estimate(tx, fees, sim);
  if (est === undefined) return "fee cap set but total fee cannot be bounded (missing gas/compute estimate or maxFee)";
  if (est > cap) return `estimated max fee ${est} exceeds cap ${cap}`;
  return undefined;
}
