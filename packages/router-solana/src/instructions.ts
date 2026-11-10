// Instruction builders the adapter/engine adds to a tx BEFORE signing.
// The router never mutates signed bytes, so a Jito tip and priority fee must
// already be inside the signed message.

import { AccountRole, address, type Address, type Instruction } from "@solana/kit";
import { JITO_TIP_ACCOUNTS as CORE_JITO_TIP_ACCOUNTS } from "@mint-engine/core";

export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address("ComputeBudget111111111111111111111111111111");

/**
 * Jito mainnet tip accounts. Any one works. Picking one at random spreads write-lock
 * contention. You can also fetch the live list from the block engine (`getTipAccounts`).
 */
export const JITO_TIP_ACCOUNTS: readonly Address[] = CORE_JITO_TIP_ACCOUNTS.map((a) => address(a));

export function randomJitoTipAccount(accounts: readonly Address[] = JITO_TIP_ACCOUNTS): Address {
  const a = accounts[Math.floor(Math.random() * accounts.length)];
  if (!a) throw new Error("no tip accounts");
  return a;
}

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** System Program `Transfer` instruction. */
export function getTransferInstruction(from: Address, to: Address, lamports: bigint | number | string): Instruction {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // Transfer discriminator
  data.set(u64le(BigInt(lamports)), 4);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Builds the Jito tip as a System transfer from `payer` to a Jito tip account.
 * Add it to the tx (usually as the last instruction) BEFORE signing. When txs are
 * sent as one bundle, only one tx in the bundle needs a tip, but per-tx tips keep
 * each tx competitive when sent through `sendTransaction`.
 */
export function getJitoTipInstruction(
  payer: Address,
  lamports: bigint | number | string,
  tipAccount: Address = randomJitoTipAccount(),
): Instruction {
  if (BigInt(lamports) <= 0n) throw new RangeError("jito tip must be > 0 lamports");
  return getTransferInstruction(payer, tipAccount, lamports);
}

/** ComputeBudget `SetComputeUnitPrice` (micro-lamports per CU). */
export function getSetComputeUnitPriceInstruction(microLamports: bigint | number | string): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  data.set(u64le(BigInt(microLamports)), 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}

/** ComputeBudget `SetComputeUnitLimit`. */
export function getSetComputeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > 0xffff_ffff) throw new RangeError(`bad CU limit: ${units}`);
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}
