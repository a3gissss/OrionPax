import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import type { PreparedTx } from "@mint-engine/core";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  getTransferInstruction,
} from "../src/index.js";

export async function signTransfer(opts: {
  payer: KeyPairSigner;
  to: Address;
  lamports: bigint;
  blockhash: string;
  lastValidBlockHeight: number;
  extra?: Instruction[];
  microLamports?: bigint;
}): Promise<Uint8Array> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(opts.payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: opts.blockhash as Blockhash, lastValidBlockHeight: BigInt(opts.lastValidBlockHeight) },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction(10_000),
          getSetComputeUnitPriceInstruction(opts.microLamports ?? 1n),
          getTransferInstruction(opts.payer.address, opts.to, opts.lamports),
          ...(opts.extra ?? []),
        ],
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  return new Uint8Array(getTransactionEncoder().encode(signed));
}

export function prepared(walletId: string, validUntil?: number): PreparedTx {
  return { chain: "solana", walletId, unsigned: new Uint8Array(), value: "0", validUntil, description: `test ${walletId}` };
}
