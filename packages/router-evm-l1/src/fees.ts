import type { FeeStrategy } from "@mint-engine/core";

/** Default tip when the strategy does not specify one: 1.5 gwei. */
export const DEFAULT_PRIORITY_FEE_WEI = 1_500_000_000n;

export interface BlockFeeInfo {
  /** baseFeePerGas of the latest block (wei). */
  baseFeePerGas: bigint | null | undefined;
}

export interface Eip1559Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** True when a cap pushed maxFeePerGas below the current base fee (tx will wait for base fee to drop). */
  belowBaseFee: boolean;
  /** True when maxFee / maxTotalFee caps lowered the computed fee. */
  capped: boolean;
}

function toBig(v: string | undefined, name: string): bigint | undefined {
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`invalid ${name}: expected a decimal wei string`);
  return BigInt(v);
}

/**
 * EIP-1559 fees for the next block: maxFee = 2 × baseFee + priority, then clamped by
 * `fees.maxFee` (per gas) and `fees.maxTotalFee / gasLimit` (per tx). Priority never exceeds maxFee.
 */
export function feeStrategyFor(
  block: BlockFeeInfo,
  fees: FeeStrategy,
  opts: { gasLimit?: bigint | number; defaultPriorityFee?: bigint } = {},
): Eip1559Fees {
  const baseFee = block.baseFeePerGas ?? 0n;
  let priority = toBig(fees.priorityFee, "priorityFee") ?? opts.defaultPriorityFee ?? DEFAULT_PRIORITY_FEE_WEI;
  let maxFee = baseFee * 2n + priority;
  let capped = false;

  const capPerGas = toBig(fees.maxFee, "maxFee");
  if (capPerGas !== undefined && maxFee > capPerGas) {
    maxFee = capPerGas;
    capped = true;
  }
  const capTotal = toBig(fees.maxTotalFee, "maxTotalFee");
  if (capTotal !== undefined) {
    const gas = opts.gasLimit === undefined ? 0n : BigInt(opts.gasLimit);
    // A hard spend cap can't be enforced without the gas limit; refuse rather than silently ignore it.
    if (gas <= 0n) throw new Error("feeStrategyFor: maxTotalFee requires opts.gasLimit");
    const perGas = capTotal / gas;
    if (maxFee > perGas) {
      maxFee = perGas;
      capped = true;
    }
  }
  if (priority > maxFee) priority = maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, belowBaseFee: maxFee < baseFee, capped };
}
