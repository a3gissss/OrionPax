// Keystore file format + crypto (scrypt KDF, AES-256-GCM) + atomic file IO.
//
// Layout on disk (JSON):
//   { version, kdf: {name, N, r, p, dkLen, salt}, cipher: {name, iv, tag}, wallets: WalletRef[], ciphertext }
// Wallet metadata (id/label/family/address) is stored in clear so the vault can be listed while
// locked, but it is bound into the GCM tag as additional authenticated data, so it cannot be
// tampered with without detection. The ciphertext is the concatenation of each wallet's 32-byte
// secret (Solana ed25519 seed / EVM secp256k1 private key) in `wallets` order.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { WalletRef } from "@mint-engine/core";
import { VaultError, WrongPassphraseError } from "./errors.js";

export const KEYSTORE_VERSION = 1;
export const SECRET_LEN = 32;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Default KDF cost: N=2^17, r=8, p=1 (~128 MiB, a few hundred ms). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

export interface KeystoreFile {
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; dkLen: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  wallets: WalletRef[];
  ciphertext: string;
}

export function validScryptParams(p: { N: unknown; r: unknown; p: unknown }): boolean {
  const { N, r, p: par } = p;
  return Number.isInteger(N) && Number.isInteger(r) && Number.isInteger(par)
    && (N as number) >= 2 ** 10 && (N as number) <= 2 ** 20 && ((N as number) & ((N as number) - 1)) === 0
    && (r as number) >= 1 && (r as number) <= 32 && (par as number) >= 1 && (par as number) <= 16;
}

export function scrypt(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const opts: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize("NFKC"), salt, 32, opts, (err, key) => {
      if (err) reject(new VaultError(`Key derivation failed (${err.message})`, "INVALID_INPUT"));
      else resolve(key);
    });
  });
}

/** Canonical AAD: fixed field order regardless of how the JSON was laid out on disk. */
function aad(file: Pick<KeystoreFile, "version" | "kdf" | "wallets">): Buffer {
  const k = file.kdf;
  return Buffer.from(JSON.stringify({
    version: file.version,
    kdf: { name: k.name, N: k.N, r: k.r, p: k.p, dkLen: k.dkLen, salt: k.salt },
    wallets: file.wallets.map((w) => ({ id: w.id, label: w.label, family: w.family, address: w.address })),
  }), "utf8");
}

export function newKdfHeader(params: ScryptParams): KeystoreFile["kdf"] {
  if (!validScryptParams(params)) throw new VaultError("Invalid scrypt parameters (N must be a power of two in 2^10..2^20, r 1..32, p 1..16)", "INVALID_INPUT");
  return { name: "scrypt", N: params.N, r: params.r, p: params.p, dkLen: 32, salt: randomBytes(16).toString("base64") };
}

/** Encrypt secrets (one 32-byte buffer per wallet, same order as `wallets`). */
export function seal(key: Buffer, kdf: KeystoreFile["kdf"], wallets: WalletRef[], secrets: Buffer[]): KeystoreFile {
  if (secrets.length !== wallets.length) throw new VaultError("Internal error: wallet/secret count mismatch", "CORRUPT");
  const iv = randomBytes(12);
  const header = { version: KEYSTORE_VERSION, kdf, wallets: wallets.map((w) => ({ ...w })) };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(header));
  const plain = Buffer.concat(secrets);
  try {
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      ...header,
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
      ciphertext: ct.toString("base64"),
    };
  } finally {
    plain.fill(0);
  }
}

/** Decrypt; throws WrongPassphraseError when the tag does not verify. Returns one buffer per wallet. */
export function open(key: Buffer, file: KeystoreFile): Buffer[] {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
  decipher.setAAD(aad(file));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
  } catch {
    // GCM cannot distinguish a wrong key from tampering; a wrong passphrase is by far the likely cause.
    throw new WrongPassphraseError();
  }
  try {
    if (plain.length !== file.wallets.length * SECRET_LEN) throw new VaultError("Keystore payload has an unexpected length", "CORRUPT");
    return file.wallets.map((_, i) => Buffer.from(plain.subarray(i * SECRET_LEN, (i + 1) * SECRET_LEN)));
  } finally {
    plain.fill(0);
  }
}

export function parseKeystore(text: string): KeystoreFile {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new VaultError("Keystore file is not valid JSON", "CORRUPT");
  }
  const f = j as Partial<KeystoreFile>;
  const ok = f && typeof f === "object"
    && f.version === KEYSTORE_VERSION
    && f.kdf?.name === "scrypt" && validScryptParams(f.kdf)
    && f.kdf.dkLen === 32 && typeof f.kdf.salt === "string"
    && f.cipher?.name === "aes-256-gcm" && typeof f.cipher.iv === "string" && typeof f.cipher.tag === "string"
    && typeof f.ciphertext === "string"
    && Array.isArray(f.wallets)
    && f.wallets.every((w) => w && typeof w.id === "string" && typeof w.label === "string"
      && (w.family === "solana" || w.family === "evm") && typeof w.address === "string");
  if (!ok) throw new VaultError("Keystore file has an unsupported or malformed structure", "CORRUPT");
  return f as KeystoreFile;
}

export async function readKeystore(file: string): Promise<KeystoreFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new VaultError(`Keystore not found at ${file}`, "NOT_FOUND");
    throw new VaultError(`Unable to read keystore (${code ?? "unknown error"})`, "CORRUPT");
  }
  return parseKeystore(text);
}

/**
 * Atomically replace `file`: write a sibling temp file with mode 0o600, fsync, then rename over the
 * target. On failure the original file is left untouched and the temp file removed.
 */
export async function writeKeystoreAtomic(file: string, data: KeystoreFile, opts: { exclusive?: boolean } = {}): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(tmp, 0o600).catch(() => {});
    if (opts.exclusive) {
      // link() fails with EEXIST if the target exists, so creation never clobbers a keystore.
      try {
        await fs.link(tmp, file);
        await fs.rm(tmp, { force: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new VaultError(`A keystore already exists at ${file}`, "EXISTS");
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw e;
        // Filesystem without hard links: best-effort existence check, then rename.
        if (await fs.stat(file).then(() => true, () => false)) throw new VaultError(`A keystore already exists at ${file}`, "EXISTS");
        await renameWithRetry(tmp, file);
      }
    } else {
      await renameWithRetry(tmp, file);
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof VaultError) throw e;
    throw new VaultError(`Unable to write keystore (${(e as NodeJS.ErrnoException).code ?? "unknown error"})`, "CORRUPT");
  }
}

// Windows can transiently refuse a rename over a file that another process (AV, indexer) has open.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}
