// EVM (secp256k1) key handling and transaction signing via viem.
// Private keys stay in Uint8Array form (never hex strings) so they can be zeroized on lock.

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex, getAddress, hexToBytes, keccak256, numberToHex, parseTransaction, serializeTransaction,
  type Hex, type TransactionSerializable,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { VaultError } from "./errors.js";

export function evmAddressFromKey(priv: Uint8Array): string {
  if (priv.length !== 32 || !secp256k1.utils.isValidPrivateKey(priv)) {
    throw new VaultError("Invalid EVM private key: not a valid secp256k1 scalar", "INVALID_KEY");
  }
  return getAddress(publicKeyToAddress(bytesToHex(secp256k1.getPublicKey(priv, false))));
}

export function generateEvmKey(): Buffer {
  for (;;) {
    const k = randomBytes(32);
    if (secp256k1.utils.isValidPrivateKey(k)) return k;
    k.fill(0);
  }
}

/** Parse a 0x-prefixed (or bare) 64-hex-char private key. Caller owns and zeroizes the result. */
export function parseEvmSecret(input: string | Uint8Array): { key: Buffer; address: string } {
  let key: Buffer;
  if (typeof input === "string") {
    const s = input.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new VaultError("Invalid EVM private key: expected 32 bytes of hex", "INVALID_KEY");
    key = Buffer.from(s, "hex");
  } else {
    if (input.length !== 32) throw new VaultError("Invalid EVM private key: expected 32 bytes", "INVALID_KEY");
    key = Buffer.from(input);
  }
  try {
    return { key, address: evmAddressFromKey(key) };
  } catch (e) {
    key.fill(0);
    throw e;
  }
}

/**
 * Sign an unsigned serialized EVM transaction (EIP-2718 typed envelope or legacy RLP, as produced
 * by viem `serializeTransaction` without a signature). Returns the signed serialized transaction.
 */
export function signEvmTransaction(unsigned: Uint8Array, priv: Uint8Array): Uint8Array {
  let tx: TransactionSerializable;
  try {
    const parsed = parseTransaction(bytesToHex(unsigned)) as TransactionSerializable & { r?: Hex; s?: Hex; v?: bigint; yParity?: number };
    if (parsed.r !== undefined || parsed.s !== undefined) {
      throw new VaultError("EVM transaction is already signed", "SIGNING");
    }
    if (parsed.chainId === undefined || parsed.chainId <= 0) {
      throw new VaultError("Refusing to sign an EVM transaction without a chainId (replayable across chains)", "SIGNING");
    }
    tx = parsed;
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError("Not a valid serialized unsigned EVM transaction", "SIGNING");
  }
  const hash = hexToBytes(keccak256(serializeTransaction(tx)));
  const sig = secp256k1.sign(hash, priv, { lowS: true });
  const r = numberToHex(sig.r, { size: 32 });
  const s = numberToHex(sig.s, { size: 32 });
  const yParity = sig.recovery;
  const signature = tx.type === "legacy"
    ? { r, s, v: BigInt(27 + yParity) }
    : { r, s, yParity };
  return hexToBytes(serializeTransaction(tx, signature));
}
