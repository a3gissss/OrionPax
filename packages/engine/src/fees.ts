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

/** Read one RLP item at `pos`; returns its payload bounds and the position after it. */
function rlpItem(b: Uint8Array, pos: number): { start: number; end: number; next: number; list: boolean } {
  const p = b[pos];
  if (p === undefined) throw new Error("rlp: out of bounds");
  if (p < 0x80) return { start: pos, end: pos + 1, next: pos + 1, list: false };
  const lenOf = (n: number, at: number) => { let l = 0; for (let i = 0; i < n; i++) l = l * 256 + (b[at + i] ?? 0); return l; };
  if (p <= 0xb7) { const l = p - 0x80; return { start: pos + 1, end: pos + 1 + l, next: pos + 1 + l, list: false }; }
  if (p <= 0xbf) { const n = p - 0xb7; const l = lenOf(n, pos + 1); const s = pos + 1 + n; return { start: s, end: s + l, next: s + l, list: false }; }
  if (p <= 0xf7) { const l = p - 0xc0; return { start: pos + 1, end: pos + 1 + l, next: pos + 1 + l, list: true }; }
  const n = p - 0xf7; const l = lenOf(n, pos + 1); const s = pos + 1 + n;
  return { start: s, end: s + l, next: s + l, list: true };
}

/**
 * gas limit and maxFeePerGas from a serialized EIP-1559 (type 2) tx, signed or unsigned.
 * Fields: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, ...]. Undefined if not type 2.
 */
export function eip1559GasBound(serialized: Uint8Array): { gas: bigint; maxFeePerGas: bigint } | undefined {
  try {
    if (serialized[0] !== 0x02) return undefined;
    const list = rlpItem(serialized, 1);
    if (!list.list) return undefined;
    const fields: bigint[] = [];
    let pos = list.start;
    for (let i = 0; i < 5; i++) {
      const it = rlpItem(serialized, pos);
      if (it.list || it.end > list.end) return undefined;
      let v = 0n;
      for (let j = it.start; j < it.end; j++) v = (v << 8n) | BigInt(serialized[j]!);
      fields.push(v);
      pos = it.next;
    }
    return { maxFeePerGas: fields[3]!, gas: fields[4]! };
  } catch {
    return undefined;
  }
}

/**
 * Worst-case total fee (base units) the tx can spend, or `undefined` if it cannot be bounded
 * from the information available. The engine fails closed when a cap is set and this is undefined.
 *
 * - EVM: gas limit × maxFeePerGas, read from the tx being signed (the most the sender can be
 *   charged for execution, native value excluded), plus `l1DataFee` when the adapter reports one
 *   (OP-stack L2s such as Base charge it on top). Falls back to `computeOrGas` × `fees.maxFee`
 *   for txs that aren't EIP-1559.
 * - Solana: base fee (1 signature) + ceil(priorityFee µlamports/CU × CU / 1e6) + Jito tip.
 */
export function estimateMaxTotalFee(tx: PreparedTx, fees: FeeStrategy, sim?: SimulationResult): bigint | undefined {
  if (CHAIN_FAMILY[tx.chain] === "evm") {
    const l1 = big(tx.l1DataFee) ?? 0n;
    const bound = eip1559GasBound(tx.unsigned);
    if (bound) return bound.gas * bound.maxFeePerGas + l1;
    const maxFee = big(fees.maxFee);
    if (tx.computeOrGas === undefined || maxFee === undefined) return undefined;
    return BigInt(Math.ceil(tx.computeOrGas)) * maxFee + l1;
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
