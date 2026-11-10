// pump.fun-compatible bonding curve (classic Anchor layout).
//
// Accounts / layout follow the original public pump.fun IDL:
//   Global        = disc(8) initialized(u8) authority(32) feeRecipient(32)
//                   initialVirtualTokenReserves(u64) initialVirtualSolReserves(u64)
//                   initialRealTokenReserves(u64) tokenTotalSupply(u64) feeBasisPoints(u64)
//   BondingCurve  = disc(8) virtualTokenReserves(u64) virtualSolReserves(u64)
//                   realTokenReserves(u64) realSolReserves(u64) tokenTotalSupply(u64) complete(bool) ...
//   buy(amount: u64, maxSolCost: u64) with 12 accounts (see buildBuy).
//
// The program id is REQUIRED so the same definition works against forks,
// clones and local fixtures of the classic layout. NOTE: the live pump.fun
// mainnet program has since added accounts to `buy` (creator vault, volume
// accumulators, fee config/program) and a creator fee, so this definition will
// NOT work against it as-is; ship a separate LaunchpadDefinition for that layout.

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "./ata.js";
import {
  applyBpsUp, BPS_DENOMINATOR, constantProductSolCost, constantProductTokensOut, feeOf,
  type BuildBuyArgs, type BuyQuote, type CurveState, type LaunchpadDefinition,
} from "./launchpad.js";

/** pump.fun mainnet program id, for reference only (see the layout note above). */
export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const PUMP_BUY_DISCRIMINATOR = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMP_GLOBAL_DISCRIMINATOR = Uint8Array.from([167, 232, 232, 177, 200, 108, 114, 127]);
export const PUMP_CURVE_DISCRIMINATOR = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);

const GLOBAL_MIN_LEN = 8 + 1 + 32 + 32 + 8 * 5; // 113
const CURVE_MIN_LEN = 8 + 8 * 5 + 1; // 49

const PUMP_ERRORS: Record<number, string> = {
  6000: "NotAuthorized",
  6001: "AlreadyInitialized",
  6002: "TooMuchSolRequired",
  6003: "TooLittleSolReceived",
  6004: "MintDoesNotMatchBondingCurve",
  6005: "BondingCurveComplete",
  6006: "BondingCurveNotComplete",
  6007: "NotInitialized",
};

export interface PumpFunOptions {
  /** Program id of the pump.fun-compatible (classic layout) deployment. */
  programId: string | PublicKey;
  /** Definition id, defaults to "pump-fun". */
  id?: string;
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

function u64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

export function encodePumpBuy(amount: bigint, maxSolCost: bigint): Buffer {
  const buf = Buffer.alloc(24);
  buf.set(PUMP_BUY_DISCRIMINATOR, 0);
  buf.writeBigUInt64LE(amount, 8);
  buf.writeBigUInt64LE(maxSolCost, 16);
  return buf;
}

export interface PumpGlobal {
  initialized: boolean;
  authority: PublicKey;
  feeRecipient: PublicKey;
  feeBps: bigint;
}

export function decodePumpGlobal(data: Uint8Array): PumpGlobal {
  if (data.length < GLOBAL_MIN_LEN || !hasPrefix(data, PUMP_GLOBAL_DISCRIMINATOR)) {
    throw new Error("not a pump.fun Global account");
  }
  return {
    initialized: data[8] === 1,
    authority: new PublicKey(data.subarray(9, 41)),
    feeRecipient: new PublicKey(data.subarray(41, 73)),
    feeBps: u64(data, 105),
  };
}

export function decodePumpCurve(data: Uint8Array) {
  if (data.length < CURVE_MIN_LEN || !hasPrefix(data, PUMP_CURVE_DISCRIMINATOR)) {
    throw new Error("not a pump.fun BondingCurve account");
  }
  return {
    virtualTokenReserves: u64(data, 8),
    virtualSolReserves: u64(data, 16),
    realTokenReserves: u64(data, 24),
    realSolReserves: u64(data, 32),
    tokenTotalSupply: u64(data, 40),
    complete: data[48] === 1,
  };
}

export function createPumpFunLaunchpad(opts: PumpFunOptions): LaunchpadDefinition {
  const programId = new PublicKey(opts.programId);
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId);

  const curveAddress = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], programId)[0];

  return {
    id: opts.id ?? "pump-fun",
    programId,
    curveAddress,

    auxAccounts() {
      return [global];
    },

    decode(mint, curveData, auxData): CurveState {
      const g = auxData[0];
      if (!g) throw new Error(`pump.fun global account ${global.toBase58()} not found`);
      const globalState = decodePumpGlobal(g);
      if (!globalState.initialized) throw new Error("pump.fun global account is not initialized");
      const c = decodePumpCurve(curveData);
      return {
        curve: curveAddress(mint),
        mint,
        complete: c.complete,
        virtualSolReserves: c.virtualSolReserves,
        virtualTokenReserves: c.virtualTokenReserves,
        realSolReserves: c.realSolReserves,
        realTokenReserves: c.realTokenReserves,
        tokenTotalSupply: c.tokenTotalSupply,
        feeBps: globalState.feeBps,
        extra: { global, feeRecipient: globalState.feeRecipient, eventAuthority },
      };
    },

    quoteBuy(state, spend, slippageBps): BuyQuote {
      const { virtualSolReserves: vSol, virtualTokenReserves: vTok } = state;
      const tokensFor = (budget: bigint) => {
        // Budget covers cost + fee: cost = budget / (1 + fee). Quote on cost - 1 so
        // pump's "+1" rounding keeps the real cost <= budget.
        const solIn = (budget * BPS_DENOMINATOR) / (BPS_DENOMINATOR + state.feeBps);
        const t = constantProductTokensOut(vSol, vTok, solIn - 1n);
        return t > state.realTokenReserves ? state.realTokenReserves : t;
      };
      // pump.fun's buy is exact-tokens-out, guarded by maxSolCost. To never pay more
      // than `spend`, buy the tokens that spend / (1 + slippage) gets at today's price;
      // the remaining headroom up to `spend` absorbs price moves before landing.
      const headroomBudget = (spend * BPS_DENOMINATOR) / (BPS_DENOMINATOR + BigInt(slippageBps));
      const tokens = tokensFor(headroomBudget);
      const cost = tokens > 0n ? constantProductSolCost(vSol, vTok, tokens) : 0n;
      const expectedSolCost = cost + feeOf(cost, state.feeBps);
      const maxSolCost = applyBpsUp(expectedSolCost, slippageBps);
      return {
        spend,
        // Exact-out: the wallet receives exactly `tokens` or the tx reverts.
        expectedTokensOut: tokens,
        minTokensOut: tokens,
        expectedSolCost,
        maxSolCost: maxSolCost > spend ? spend : maxSolCost,
        slippageBps,
      };
    },

    buildBuy({ state, user, userAta, tokenProgram, quote }: BuildBuyArgs) {
      const feeRecipient = state.extra.feeRecipient;
      if (!(feeRecipient instanceof PublicKey)) throw new Error("missing fee recipient in curve state");
      const associatedCurve = getAssociatedTokenAddress(state.mint, state.curve, tokenProgram);
      // pump.fun's buy takes an exact token amount; the slippage guard is maxSolCost.
      return [
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: global, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: state.mint, isSigner: false, isWritable: false },
            { pubkey: state.curve, isSigner: false, isWritable: true },
            { pubkey: associatedCurve, isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: programId, isSigner: false, isWritable: false },
          ],
          data: encodePumpBuy(quote.expectedTokensOut, quote.maxSolCost),
        }),
      ];
    },

    errorName(code) {
      return PUMP_ERRORS[code];
    },
  };
}
