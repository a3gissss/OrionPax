// Minimal helpers for reading signed Solana wire transactions.

import {
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

const b58 = getBase58Decoder();
const b64 = getBase64Decoder();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ADVANCE_NONCE_DISCRIMINATOR = 4;

export interface WireInfo {
  /** Fee-payer signature (base58), i.e. the tx id. */
  signature: string;
  base64: string;
  /** Recent blockhash, or the nonce value for durable-nonce txs. */
  lifetimeToken: string;
  /** True if the first instruction is System AdvanceNonceAccount (tx never expires by blockhash). */
  durableNonce: boolean;
}

/** Decode a signed wire tx once. Throws if the fee payer hasn't signed. */
export function inspectWireTransaction(signedTx: Uint8Array): WireInfo {
  const tx = getTransactionDecoder().decode(signedTx);
  const first = Object.values(tx.signatures)[0];
  if (!first || first.every((b) => b === 0)) throw new Error("transaction is not signed by its fee payer");
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  // First instruction's program index + data, for legacy/v0 and v1 message layouts.
  let programIndex: number | undefined;
  let data: Uint8Array | undefined;
  if ("instructions" in msg) {
    programIndex = msg.instructions[0]?.programAddressIndex;
    data = msg.instructions[0]?.data as Uint8Array | undefined;
  } else {
    programIndex = msg.instructionHeaders[0]?.programAccountIndex;
    data = msg.instructionPayloads[0]?.instructionData as Uint8Array | undefined;
  }
  const durableNonce =
    programIndex !== undefined &&
    msg.staticAccounts[programIndex] === SYSTEM_PROGRAM &&
    data !== undefined &&
    data.length >= 4 &&
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) === ADVANCE_NONCE_DISCRIMINATOR;
  return { signature: b58.decode(first), base64: b64.decode(signedTx), lifetimeToken: msg.lifetimeToken, durableNonce };
}

export function signatureOf(signedTx: Uint8Array): string {
  return inspectWireTransaction(signedTx).signature;
}

/** Recent blockhash (or nonce value) a wire transaction was built against. */
export function blockhashOf(signedTx: Uint8Array): string {
  return inspectWireTransaction(signedTx).lifetimeToken;
}
