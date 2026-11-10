// Pure helpers for reading a Core Candy Guard's default guard set.
// Kept free of RPC so they can be unit-tested without a validator.

import { isSome, type Option, type PublicKey } from "@metaplex-foundation/umi";

/** Guards this adapter knows how to satisfy without extra user input. */
export const SUPPORTED_GUARDS = [
  "botTax",
  "solPayment",
  "startDate",
  "endDate",
  "mintLimit",
  "redeemedAmount",
  "addressGate",
] as const;

/**
 * Guards that need off-chain proofs, third-party co-signers or human verification
 * (gatekeeper = Civic/CAPTCHA-style pass). We refuse these rather than work around them.
 */
export const REFUSED_GUARDS = new Set(["gatekeeper", "thirdPartySigner"]);

export interface GuardSummary {
  /** Unix ms. */
  startsAt?: number;
  /** Unix ms. */
  endsAt?: number;
  /** Lamports per unit (decimal string). "0" if no solPayment guard. */
  priceLamports: string;
  solPaymentDestination?: PublicKey;
  mintLimit?: { id: number; limit: number };
  redeemedAmountMax?: bigint;
  addressGate?: PublicKey;
  botTax?: boolean;
  /** Guards that are set but not handled by this adapter. */
  unsupported: string[];
}

/** Minimal shape of a deserialized guard set: guard name -> Option<settings>. */
export type GuardSetLike = Record<string, Option<unknown>>;

function secondsToMs(v: bigint | number): number {
  return Number(v) * 1000;
}

export function summarizeGuards(guards: GuardSetLike): GuardSummary {
  const out: GuardSummary = { priceLamports: "0", unsupported: [] };
  const supported = new Set<string>(SUPPORTED_GUARDS);
  for (const [name, opt] of Object.entries(guards)) {
    if (!opt || !isSome(opt)) continue;
    const v = opt.value as Record<string, unknown>;
    switch (name) {
      case "startDate":
        out.startsAt = secondsToMs(v.date as bigint);
        break;
      case "endDate":
        out.endsAt = secondsToMs(v.date as bigint);
        break;
      case "solPayment": {
        const lamports = v.lamports as { basisPoints: bigint };
        out.priceLamports = lamports.basisPoints.toString();
        out.solPaymentDestination = v.destination as PublicKey;
        break;
      }
      case "mintLimit":
        out.mintLimit = { id: Number(v.id), limit: Number(v.limit) };
        break;
      case "redeemedAmount":
        out.redeemedAmountMax = BigInt(v.maximum as bigint | number);
        break;
      case "botTax":
        out.botTax = true;
        break;
      case "addressGate":
        out.addressGate = v.address as PublicKey;
        break;
      default:
        if (!supported.has(name)) out.unsupported.push(name);
    }
  }
  return out;
}

/** Compute-unit limit from a simulated usage plus a safety margin (default 10%). */
export function computeUnitLimit(unitsConsumed: number, marginBps = 1_000): number {
  const MAX_CU = 1_400_000;
  const limit = Math.ceil((unitsConsumed * (10_000 + marginBps)) / 10_000);
  return Math.min(Math.max(limit, 1), MAX_CU);
}

/** FeeStrategy.priorityFee (micro-lamports per CU, decimal string) -> bigint. */
export function parsePriorityFee(priorityFee: string | undefined): bigint {
  if (priorityFee === undefined || priorityFee === "") return 0n;
  if (!/^\d+$/.test(priorityFee)) throw new Error(`priorityFee must be a non-negative integer string, got "${priorityFee}"`);
  return BigInt(priorityFee);
}

/** Total priority fee in lamports for a given CU limit and price. */
export function priorityFeeLamports(cuLimit: number, microLamportsPerCu: bigint): bigint {
  // ceil(cu * price / 1e6)
  return (BigInt(cuLimit) * microLamportsPerCu + 999_999n) / 1_000_000n;
}
