// @mint-engine/router-solana: TxRouter for Solana plus the pre-signing helpers
// (blockhash cache, priority-fee estimate, Jito tip / compute-budget instructions).
//
// Before signing, the adapter or engine should:
//   1. take `blockhash` + `lastValidBlockHeight` from a running BlockhashCache and set
//      PreparedTx.validUntil = lastValidBlockHeight (confirm() uses it to detect expiry);
//   2. add SetComputeUnitLimit / SetComputeUnitPrice (see estimatePriorityFee);
//   3. if FeeStrategy.jitoTip is set, add getJitoTipInstruction(payer, jitoTip). The tip must be
//      INSIDE the signed tx. The router only broadcasts signed bytes and never changes them.

export { SolanaTxRouter, createSolanaRouter, DoubleSubmitError, jitoEndpoints, JITO_MAX_BUNDLE_SIZE } from "./router.js";
export type { SolanaRouterOptions, SolanaRouterRpc } from "./router.js";
export { BlockhashCache } from "./blockhash.js";
export type { BlockhashCacheOptions, CachedBlockhash } from "./blockhash.js";
export {
  estimatePriorityFee,
  percentileOf,
  maxPriceUnderCap,
  LAMPORTS_PER_SIGNATURE,
  DEFAULT_COMPUTE_UNITS,
} from "./fees.js";
export type { EstimatePriorityFeeOptions, PriorityFeeEstimate } from "./fees.js";
export {
  JITO_TIP_ACCOUNTS,
  randomJitoTipAccount,
  getJitoTipInstruction,
  getTransferInstruction,
  getSetComputeUnitPriceInstruction,
  getSetComputeUnitLimitInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
} from "./instructions.js";
export { signatureOf, blockhashOf, inspectWireTransaction } from "./wire.js";
export type { WireInfo } from "./wire.js";
