// EIP-1559 fee selection for the L2s.
//
// Base (OP Stack): the sequencer orders txs by priority fee *within* each 200 ms
// canonical block (post-Denim; previously a Flashblock). A modest tip helps
// inside a block, but arriving before the cut matters more than outbidding.
//
// Robinhood Chain (Arbitrum Orbit / Nitro): the sequencer is first-come-first-serve
// and ignores the tip for ordering, so we pay a minimal (zero) tip.

import type { ChainId, FeeStrategy } from "@mint-engine/core";

export type L2Chain = Extract<ChainId, "base" | "robinhood">;

/** Default Base tip when FeeStrategy.priorityFee is unset: 0.01 gwei. */
export const BASE_DEFAULT_PRIORITY_FEE = 10_000_000n;
/** Robinhood (FCFS) tip: zero, since Nitro does not order by tip. */
export const ROBINHOOD_PRIORITY_FEE = 0n;
/** Default headroom over the current base fee for maxFeePerGas. */
export const DEFAULT_BASE_FEE_MULTIPLIER = 2n;

export interface L2FeeInput {
  /** Latest block's baseFeePerGas, in wei. */
  baseFeePerGas: bigint;
  /** Gas limit of the tx, used to enforce FeeStrategy.maxTotalFee. */
  gas?: bigint;
}

export interface L2Fees {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

export function l2FeeStrategy(chain: L2Chain, fees: FeeStrategy, input: L2FeeInput): L2Fees {
  let priority: bigint;
  if (chain === "base") {
    priority = fees.priorityFee !== undefined ? parseWei(fees.priorityFee, "priorityFee") : BASE_DEFAULT_PRIORITY_FEE;
  } else {
    priority = ROBINHOOD_PRIORITY_FEE;
  }

  let maxFee = fees.maxFee !== undefined
    ? parseWei(fees.maxFee, "maxFee")
    : input.baseFeePerGas * DEFAULT_BASE_FEE_MULTIPLIER + priority;

  if (fees.maxTotalFee !== undefined) {
    if (input.gas === undefined || input.gas <= 0n) {
      throw new Error("FeeStrategy.maxTotalFee needs the tx gas limit to be enforced");
    }
    const cap = parseWei(fees.maxTotalFee, "maxTotalFee") / input.gas;
    if (cap < maxFee) maxFee = cap;
  }
  if (maxFee < input.baseFeePerGas) {
    throw new Error(`maxFeePerGas ${maxFee} is below the current base fee ${input.baseFeePerGas}; the tx would not be included`);
  }
  if (priority > maxFee) priority = maxFee;

  return { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee };
}

function parseWei(v: string, field: string): bigint {
  if (!/^\d+$/.test(v.trim())) throw new Error(`FeeStrategy.${field} must be a non-negative integer wei string`);
  return BigInt(v.trim());
}
