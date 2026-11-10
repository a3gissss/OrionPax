// Solana (ed25519) key handling and transaction signing via @solana/kit.

import { randomBytes } from "node:crypto";
import {
  createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, signBytes,
} from "@solana/kit";
import { VaultError } from "./errors.js";

export interface SolanaKey {
  address: string;
  keyPair: CryptoKeyPair;
}

export async function solanaKeyFromSeed(seed: Uint8Array): Promise<SolanaKey> {
  if (seed.length !== 32) throw new VaultError("Solana seed must be 32 bytes", "INVALID_KEY");
  // Non-extractable: the CryptoKey cannot be exported back out of WebCrypto.
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed, false);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  return { address, keyPair };
}

export function generateSolanaSeed(): Buffer {
  return randomBytes(32);
}

/**
 * Accepts a 64-byte keypair (JSON array as produced by `solana-keygen`, Uint8Array, or base58 string)
 * or a 32-byte seed. Returns the 32-byte seed (caller owns and zeroizes it) and, for 64-byte inputs,
 * the embedded public key bytes which are checked against the derived key.
 */
export async function parseSolanaSecret(input: string | Uint8Array | number[]): Promise<{ seed: Buffer; address: string }> {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    const s = input.trim();
    if (s.startsWith("[")) {
      let arr: unknown;
      try {
        arr = JSON.parse(s);
      } catch {
        throw new VaultError("Invalid Solana secret key: malformed JSON byte array", "INVALID_KEY");
      }
      bytes = toByteArray(arr);
    } else {
      try {
        bytes = new Uint8Array(getBase58Encoder().encode(s));
      } catch {
        throw new VaultError("Invalid Solana secret key: not valid base58", "INVALID_KEY");
      }
      if (bytes.length !== 64) {
        // A 32-byte base58 string is almost always an address (public key), not a secret.
        bytes.fill(0);
        throw new VaultError("Invalid Solana secret key: base58 input must be a 64-byte keypair (did you paste an address?)", "INVALID_KEY");
      }
    }
  } else {
    bytes = toByteArray(input);
  }
  try {
    if (bytes.length !== 64 && bytes.length !== 32) {
      throw new VaultError(`Invalid Solana secret key: expected 64 (keypair) or 32 (seed) bytes, got ${bytes.length}`, "INVALID_KEY");
    }
    const seed = Buffer.from(bytes.subarray(0, 32));
    let key: SolanaKey;
    try {
      key = await solanaKeyFromSeed(seed);
    } catch {
      seed.fill(0);
      throw new VaultError("Invalid Solana secret key", "INVALID_KEY");
    }
    if (bytes.length === 64) {
      const embedded = getBase58Decoder().decode(bytes.subarray(32));
      if (embedded !== key.address) {
        seed.fill(0);
        throw new VaultError("Invalid Solana secret key: public half does not match the private half", "INVALID_KEY");
      }
    }
    return { seed, address: key.address };
  } finally {
    // Wipe our working copy; when the caller passed a Uint8Array we copied it in toByteArray.
    bytes.fill(0);
  }
}

function toByteArray(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return Uint8Array.from(v as number[]);
  throw new VaultError("Invalid Solana secret key: expected an array of bytes", "INVALID_KEY");
}

// ---------- Transaction wire format ----------

class Reader {
  off = 0;
  constructor(readonly b: Uint8Array) {}
  u8(): number {
    if (this.off >= this.b.length) throw new RangeError("eof");
    return this.b[this.off++]!;
  }
  shortvec(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      v |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) return v;
    }
    throw new RangeError("shortvec too long");
  }
  take(n: number): Uint8Array {
    if (this.off + n > this.b.length) throw new RangeError("eof");
    const out = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  get done() { return this.off === this.b.length; }
}

function shortvecEncode(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(byte); break; }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

interface ParsedMessage { numSigners: number; signerKeys: Uint8Array[] }

/** Strictly parse a legacy or v0 message; returns null unless the bytes are exactly one message. */
export function parseMessage(msg: Uint8Array): ParsedMessage | null {
  try {
    const r = new Reader(msg);
    let first = r.u8();
    let versioned = false;
    if (first & 0x80) {
      if ((first & 0x7f) !== 0) return null; // only v0 is defined
      versioned = true;
      first = r.u8();
    }
    const numSigners = first;
    r.u8(); r.u8(); // readonly signed / unsigned counts
    const nKeys = r.shortvec();
    if (numSigners === 0 || numSigners > nKeys) return null;
    const keys: Uint8Array[] = [];
    for (let i = 0; i < nKeys; i++) keys.push(r.take(32));
    r.take(32); // recent blockhash / nonce
    const nIx = r.shortvec();
    for (let i = 0; i < nIx; i++) {
      r.u8();
      r.take(r.shortvec());
      r.take(r.shortvec());
    }
    if (versioned) {
      const nLut = r.shortvec();
      for (let i = 0; i < nLut; i++) {
        r.take(32);
        r.take(r.shortvec());
        r.take(r.shortvec());
      }
    }
    if (!r.done) return null;
    return { numSigners, signerKeys: keys.slice(0, numSigners) };
  } catch {
    return null;
  }
}

/** Parse a full wire transaction (signatures + message); returns null if it is not one. */
function parseWireTx(tx: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array; parsed: ParsedMessage } | null {
  try {
    const r = new Reader(tx);
    const n = r.shortvec();
    if (n === 0) return null;
    const sigs: Uint8Array[] = [];
    for (let i = 0; i < n; i++) sigs.push(r.take(64));
    const message = tx.subarray(r.off);
    const parsed = parseMessage(message);
    if (!parsed || parsed.numSigners !== n) return null;
    return { signatures: sigs, message, parsed };
  } catch {
    return null;
  }
}

/**
 * Sign a Solana transaction. `unsigned` may be either the serialized message bytes, or a full wire
 * transaction whose signature slots are partially filled (other signers' signatures are preserved).
 * Returns the serialized wire transaction with this wallet's signature in its slot.
 */
export async function signSolanaTransaction(unsigned: Uint8Array, key: SolanaKey): Promise<Uint8Array> {
  const pub = new Uint8Array(getBase58Encoder().encode(key.address));
  let message: Uint8Array;
  let signatures: Uint8Array[];
  let signerKeys: Uint8Array[];
  const wire = parseWireTx(unsigned);
  if (wire) {
    message = wire.message;
    signatures = wire.signatures.map((s) => new Uint8Array(s));
    signerKeys = wire.parsed.signerKeys;
  } else {
    const parsed = parseMessage(unsigned);
    if (!parsed) throw new VaultError("Not a valid serialized Solana transaction or message", "SIGNING");
    message = unsigned;
    signatures = parsed.signerKeys.map(() => new Uint8Array(64));
    signerKeys = parsed.signerKeys;
  }
  const idx = signerKeys.findIndex((k) => bytesEqual(k, pub));
  if (idx < 0) throw new VaultError(`Wallet ${key.address} is not a required signer of this transaction`, "SIGNING");
  signatures[idx] = new Uint8Array(await signBytes(key.keyPair.privateKey, message));
  const parts = [shortvecEncode(signatures.length), ...signatures, message];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
