// Encrypted wallet vault: 1..MAX_WALLETS_PER_JOB Solana + EVM wallets in one keystore file.

import { randomBytes } from "node:crypto";
import {
  CHAIN_FAMILY, MAX_WALLETS_PER_JOB,
  type ChainConfig, type ChainFamily, type ChainId, type WalletRef, type WalletSigner,
} from "@mint-engine/core";
import { readBalance } from "./balances.js";
import { VaultError, VaultLockedError } from "./errors.js";
import { evmAddressFromKey, generateEvmKey, parseEvmSecret, signEvmTransaction } from "./evm.js";
import {
  DEFAULT_SCRYPT, newKdfHeader, open, readKeystore, scrypt, seal, writeKeystoreAtomic,
  type KeystoreFile, type ScryptParams,
} from "./keystore.js";
import { generateSolanaSeed, parseSolanaSecret, signSolanaTransaction, solanaKeyFromSeed, type SolanaKey } from "./solana.js";

export const MAX_LABEL_LENGTH = 64;
export const MIN_PASSPHRASE_LENGTH = 8;

export interface CreateVaultOptions {
  /** scrypt cost parameters; defaults to N=2^17, r=8, p=1. Lower only for tests. */
  scrypt?: ScryptParams;
}

export type ImportSecret =
  | { family: "solana"; secret: string | Uint8Array | number[]; label?: string }
  | { family: "evm"; secret: string | Uint8Array; label?: string };

interface Unlocked {
  key: Buffer;
  kdf: KeystoreFile["kdf"];
  /** wallet id -> 32-byte secret (Solana seed / EVM private key). */
  secrets: Map<string, Buffer>;
  /** Cached non-extractable WebCrypto keys for Solana wallets. */
  solanaKeys: Map<string, SolanaKey>;
}

export class WalletVault {
  #wallets: WalletRef[];
  #unlocked: Unlocked | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** Incremented by lock(); lets in-flight unlock() calls notice they were superseded. */
  #epoch = 0;

  private constructor(readonly path: string, wallets: WalletRef[]) {
    this.#wallets = wallets;
  }

  /** Create a new, empty keystore at `path` (fails if one exists). The returned vault is unlocked. */
  static async create(path: string, passphrase: string, opts: CreateVaultOptions = {}): Promise<WalletVault> {
    checkPassphrase(passphrase);
    const params = opts.scrypt ?? DEFAULT_SCRYPT;
    const kdf = newKdfHeader(params);
    const key = await scrypt(passphrase, Buffer.from(kdf.salt, "base64"), params);
    try {
      await writeKeystoreAtomic(path, seal(key, kdf, [], []), { exclusive: true });
    } catch (e) {
      key.fill(0);
      throw e;
    }
    const vault = new WalletVault(path, []);
    vault.#unlocked = { key, kdf, secrets: new Map(), solanaKeys: new Map() };
    return vault;
  }

  /** Open an existing keystore in the locked state. Wallets can be listed; signing needs unlock(). */
  static async open(path: string): Promise<WalletVault> {
    const file = await readKeystore(path);
    return new WalletVault(path, file.wallets.map(cloneRef));
  }

  get isUnlocked(): boolean {
    return this.#unlocked !== null;
  }

  get size(): number {
    return this.#wallets.length;
  }

  list(): WalletRef[] {
    return this.#wallets.map(cloneRef);
  }

  get(id: string): WalletRef {
    const w = this.#wallets.find((x) => x.id === id);
    if (!w) throw new VaultError(`Unknown wallet id ${JSON.stringify(id)}`, "NOT_FOUND");
    return cloneRef(w);
  }

  /**
   * Decrypt the keystore for this session. Throws WrongPassphraseError on a bad passphrase; the
   * file is never written by unlock, and an already-unlocked session stays as it was.
   */
  unlock(passphrase: string): Promise<void> {
    // Captured synchronously at call time: a lock() issued after this call must win, even if the
    // unlock is still queued behind another operation.
    const epoch = this.#epoch;
    return this.#serial(async () => {
      if (typeof passphrase !== "string" || passphrase.length === 0) throw new VaultError("Passphrase is required", "INVALID_INPUT");
      const file = await readKeystore(this.path);
      const key = await scrypt(passphrase, Buffer.from(file.kdf.salt, "base64"), file.kdf);
      let secrets: Buffer[];
      try {
        secrets = open(key, file);
      } catch (e) {
        key.fill(0);
        throw e;
      }
      const state: Unlocked = { key, kdf: file.kdf, secrets: new Map(), solanaKeys: new Map() };
      try {
        for (const [i, w] of file.wallets.entries()) {
          const secret = secrets[i]!;
          state.secrets.set(w.id, secret);
          const derived = w.family === "solana"
            ? await solanaKeyFromSeed(secret).then((k) => { state.solanaKeys.set(w.id, k); return k.address; })
            : evmAddressFromKey(secret);
          if (derived !== w.address) throw new VaultError(`Keystore entry ${w.id} does not match its address`, "CORRUPT");
        }
      } catch (e) {
        wipe(state);
        for (const s of secrets) s.fill(0);
        throw e;
      }
      if (epoch !== this.#epoch) {
        // lock() was called while we were deriving/decrypting: honour the lock.
        wipe(state);
        throw new VaultLockedError();
      }
      if (this.#unlocked) wipe(this.#unlocked);
      this.#unlocked = state;
      this.#wallets = file.wallets.map(cloneRef);
    });
  }

  /** Forget the session key and zeroize all in-memory secret material. Signers stop working. */
  lock(): void {
    this.#epoch++;
    if (this.#unlocked) wipe(this.#unlocked);
    this.#unlocked = null;
  }

  /** Generate a fresh wallet. */
  generate(family: ChainFamily, label?: string): Promise<WalletRef> {
    return this.#serial(async () => {
      this.#requireRoom();
      const secret = family === "solana" ? generateSolanaSeed() : family === "evm" ? generateEvmKey() : null;
      if (!secret) throw new VaultError(`Unknown wallet family ${JSON.stringify(family)}`, "INVALID_INPUT");
      const address = family === "solana" ? (await solanaKeyFromSeed(secret)).address : evmAddressFromKey(secret);
      return this.#add(family, address, secret, label);
    });
  }

  /** Import an existing key. Solana: 64-byte keypair (JSON array / bytes / base58) or 32-byte seed. EVM: hex private key. */
  import(input: ImportSecret): Promise<WalletRef> {
    return this.#serial(async () => {
      this.#requireRoom();
      let parsed: { secret: Buffer; address: string };
      if (input.family === "solana") {
        const r = await parseSolanaSecret(input.secret);
        parsed = { secret: r.seed, address: r.address };
      } else if (input.family === "evm") {
        const r = parseEvmSecret(input.secret);
        parsed = { secret: r.key, address: r.address };
      } else {
        throw new VaultError("Unknown wallet family", "INVALID_INPUT");
      }
      return this.#add(input.family, parsed.address, parsed.secret, input.label);
    });
  }

  importSolana(secret: string | Uint8Array | number[], label?: string): Promise<WalletRef> {
    return this.import({ family: "solana", secret, label });
  }

  importEvm(secret: string | Uint8Array, label?: string): Promise<WalletRef> {
    return this.import({ family: "evm", secret, label });
  }

  setLabel(id: string, label: string): Promise<WalletRef> {
    return this.#serial(async () => {
      const state = this.#requireUnlocked();
      const idx = this.#indexOf(id);
      const next = this.#wallets.map(cloneRef);
      next[idx]!.label = normalizeLabel(label);
      await this.#persist(state, next);
      return cloneRef(next[idx]!);
    });
  }

  remove(id: string): Promise<void> {
    return this.#serial(async () => {
      const state = this.#requireUnlocked();
      const idx = this.#indexOf(id);
      const next = this.#wallets.filter((_, i) => i !== idx).map(cloneRef);
      await this.#persist(state, next);
      state.secrets.get(id)?.fill(0);
      state.secrets.delete(id);
      state.solanaKeys.delete(id);
    });
  }

  /**
   * A signer for one wallet. The signer looks up key material at signing time, so it fails with
   * VaultLockedError once the vault is locked.
   */
  signer(id: string): WalletSigner {
    const wallet = this.get(id);
    const vault = this;
    return {
      /** Current WalletRef (reflects later label changes). */
      get wallet(): WalletRef {
        const live = vault.#wallets.find((w) => w.id === wallet.id);
        return live ? cloneRef(live) : wallet;
      },
      signTransaction: async (unsigned: Uint8Array): Promise<Uint8Array> => {
        const state = this.#requireUnlocked();
        if (!(unsigned instanceof Uint8Array)) throw new VaultError("Transaction must be a Uint8Array", "SIGNING");
        if (wallet.family === "solana") {
          const key = state.solanaKeys.get(wallet.id);
          if (!key) throw new VaultError(`Wallet ${wallet.id} is no longer in the vault`, "NOT_FOUND");
          return signSolanaTransaction(unsigned, key);
        }
        const secret = state.secrets.get(wallet.id);
        if (!secret) throw new VaultError(`Wallet ${wallet.id} is no longer in the vault`, "NOT_FOUND");
        return signEvmTransaction(unsigned, secret);
      },
    };
  }

  /** Signers for a job: 1..MAX_WALLETS_PER_JOB distinct wallet ids. */
  signers(ids: string[]): WalletSigner[] {
    if (ids.length === 0) throw new VaultError("At least one wallet is required", "INVALID_INPUT");
    if (ids.length > MAX_WALLETS_PER_JOB) {
      throw new VaultError(`At most ${MAX_WALLETS_PER_JOB} wallets per job (got ${ids.length})`, "VAULT_FULL");
    }
    if (new Set(ids).size !== ids.length) throw new VaultError("Duplicate wallet ids", "DUPLICATE");
    this.#requireUnlocked();
    return ids.map((id) => this.signer(id));
  }

  /** Native balance (lamports / wei, decimal string) of a wallet on a chain via the given RPC URL. */
  async getBalance(id: string, chain: ChainId, rpcUrl: string): Promise<string> {
    return readBalance(this.get(id), chain, rpcUrl);
  }

  /**
   * Balances for every chain config matching the wallet's family (shape of WalletView.balances).
   * Chains whose RPC fails are omitted so one bad endpoint does not hide the others.
   */
  async getBalances(id: string, chains: Array<Pick<ChainConfig, "chain" | "rpcUrl">>): Promise<Partial<Record<ChainId, string>>> {
    const w = this.get(id);
    const relevant = chains.filter((c) => CHAIN_FAMILY[c.chain] === w.family);
    const results = await Promise.allSettled(relevant.map((c) => readBalance(w, c.chain, c.rpcUrl)));
    const out: Partial<Record<ChainId, string>> = {};
    relevant.forEach((c, i) => {
      const r = results[i]!;
      if (r.status === "fulfilled") out[c.chain] = r.value;
    });
    return out;
  }

  // ---------- internals ----------

  async #add(family: ChainFamily, address: string, secret: Buffer, label: string | undefined): Promise<WalletRef> {
    try {
      const state = this.#requireUnlocked();
      this.#requireRoom();
      if (this.#wallets.some((w) => w.family === family && w.address === address)) {
        throw new VaultError(`Wallet ${address} is already in the vault`, "DUPLICATE");
      }
      const ref: WalletRef = {
        id: newId(this.#wallets),
        label: label === undefined ? defaultLabel(family, this.#wallets) : normalizeLabel(label),
        family,
        address,
      };
      const solanaKey = family === "solana" ? await solanaKeyFromSeed(secret) : undefined;
      const next = [...this.#wallets.map(cloneRef), ref];
      const secrets = new Map(state.secrets);
      secrets.set(ref.id, secret);
      await this.#persist(state, next, secrets);
      if (this.#unlocked === state) {
        state.secrets.set(ref.id, secret);
        if (solanaKey) state.solanaKeys.set(ref.id, solanaKey);
      } else {
        secret.fill(0); // locked while the write was in flight; it is safely on disk
      }
      return cloneRef(ref);
    } catch (e) {
      secret.fill(0);
      throw e;
    }
  }

  /** Re-encrypt and atomically write `wallets`; only commit to memory after the write succeeds. */
  async #persist(state: Unlocked, wallets: WalletRef[], secrets: Map<string, Buffer> = state.secrets): Promise<void> {
    // Checked synchronously right before seal(): a lock() that raced an awaited step has already
    // replaced #unlocked, so we never encrypt with a wiped (zeroed) key.
    if (this.#unlocked !== state) throw new VaultLockedError();
    const ordered = wallets.map((w) => {
      const s = secrets.get(w.id);
      if (!s) throw new VaultError(`Internal error: missing key for ${w.id}`, "CORRUPT");
      return s;
    });
    await writeKeystoreAtomic(this.path, seal(state.key, state.kdf, wallets, ordered));
    this.#wallets = wallets;
  }

  #requireUnlocked(): Unlocked {
    if (!this.#unlocked) throw new VaultLockedError();
    return this.#unlocked;
  }

  #requireRoom(): void {
    this.#requireUnlocked();
    if (this.#wallets.length >= MAX_WALLETS_PER_JOB) {
      throw new VaultError(`Vault is full: at most ${MAX_WALLETS_PER_JOB} wallets`, "VAULT_FULL");
    }
  }

  #indexOf(id: string): number {
    const idx = this.#wallets.findIndex((w) => w.id === id);
    if (idx < 0) throw new VaultError(`Unknown wallet id ${JSON.stringify(id)}`, "NOT_FOUND");
    return idx;
  }

  /** Serialize mutating operations so concurrent calls cannot interleave file writes. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }
}

function wipe(state: Unlocked): void {
  state.key.fill(0);
  for (const s of state.secrets.values()) s.fill(0);
  state.secrets.clear();
  state.solanaKeys.clear();
}

function cloneRef(w: WalletRef): WalletRef {
  return { id: w.id, label: w.label, family: w.family, address: w.address };
}

function checkPassphrase(p: string): void {
  if (typeof p !== "string" || p.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`, "INVALID_INPUT");
  }
}

function normalizeLabel(label: string): string {
  const l = typeof label === "string" ? label.trim() : "";
  if (l.length === 0 || l.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(l)) {
    throw new VaultError(`Label must be 1-${MAX_LABEL_LENGTH} printable characters`, "INVALID_INPUT");
  }
  return l;
}

function defaultLabel(family: ChainFamily, existing: WalletRef[]): string {
  const prefix = family === "solana" ? "Solana" : "EVM";
  const used = new Set(existing.map((w) => w.label));
  for (let n = 1; ; n++) if (!used.has(`${prefix} ${n}`)) return `${prefix} ${n}`;
}

function newId(existing: WalletRef[]): string {
  for (;;) {
    const id = `w_${randomBytes(6).toString("hex")}`;
    if (!existing.some((w) => w.id === id)) return id;
  }
}
