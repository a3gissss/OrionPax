import { promises as fs, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  address, appendTransactionMessageInstruction, blockhash, compileTransaction, createKeyPairFromPrivateKeyBytes,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getTransactionDecoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, verifySignature, type SignatureBytes,
} from "@solana/kit";
import { parseTransaction, recoverTransactionAddress, serializeTransaction, toHex, hexToBytes, type TransactionSerializableEIP1559 } from "viem";
import { MAX_WALLETS_PER_JOB } from "@mint-engine/core";
import { VaultError, VaultLockedError, WalletVault, WrongPassphraseError } from "../src/index.js";

const FAST = { scrypt: { N: 2 ** 12, r: 8, p: 1 } };
const PASS = "correct horse battery staple";
// Well-known Anvil/Hardhat test key #0 (public, local-only).
const ANVIL0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL0_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "vault-test-"));
  file = path.join(dir, "vault.keystore");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function solanaTransferMessage(from: string, lamports = 1000n) {
  const to = address("11111111111111111111111111111112");
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"), lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstruction({
      programAddress: address("11111111111111111111111111111111"),
      accounts: [{ address: address(from), role: 3 }, { address: to, role: 1 }],
      data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([lamports]).buffer)]),
    }, m),
  );
  return compileTransaction(msg);
}

describe("WalletVault", () => {
  it("creates, generates both families, persists, and lists WalletRefs without secrets", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const s = await v.generate("solana");
    const e = await v.generate("evm", "  Hot EVM  ");
    expect(s).toMatchObject({ family: "solana", label: "Solana 1" });
    expect(e).toMatchObject({ family: "evm", label: "Hot EVM" });
    expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys(s).sort()).toEqual(["address", "family", "id", "label"]);

    const reopened = await WalletVault.open(file);
    expect(reopened.isUnlocked).toBe(false);
    expect(reopened.list()).toEqual([s, e]);

    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("imports Solana 64-byte arrays, base58 and EVM hex, rejecting bad input without echoing it", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const kp = await createKeyPairFromPrivateKeyBytes(seed, true);
    const addr = await getAddressFromPublicKey(kp.publicKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const full = [...seed, ...pub];

    const a = await v.importSolana(full, "arr");
    expect(a.address).toBe(addr);
    await expect(v.importSolana(getBase58Decoder().decode(Uint8Array.from(full)))).rejects.toMatchObject({ code: "DUPLICATE" });
    await v.remove(a.id);
    const b = await v.importSolana(getBase58Decoder().decode(Uint8Array.from(full)));
    expect(b.address).toBe(addr);
    await v.remove(b.id);
    expect((await v.importSolana(JSON.stringify(full))).address).toBe(addr);

    const evm = await v.importEvm(ANVIL0_KEY);
    expect(evm.address).toBe(ANVIL0_ADDR);

    const badPub = [...seed, ...new Uint8Array(32).fill(7)];
    await expect(v.importSolana(badPub)).rejects.toMatchObject({ code: "INVALID_KEY" });
    const secretish = "zz" + "ab".repeat(31);
    const err = await v.importEvm(secretish).catch((x) => x as Error);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.message).not.toContain(secretish);
    await expect(v.importEvm("0x" + "00".repeat(32))).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("keystore file never contains plaintext keys", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    await v.importEvm(ANVIL0_KEY);
    const text = await fs.readFile(file, "utf8");
    expect(text.toLowerCase()).not.toContain(ANVIL0_KEY.slice(2));
    expect(text).not.toContain(PASS);
  });

  it("wrong passphrase throws a clear error and never touches the file", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    await v.generate("evm");
    const before = await fs.readFile(file);
    const mtime = statSync(file).mtimeMs;

    const locked = await WalletVault.open(file);
    const err = await locked.unlock("wrong passphrase!").catch((x) => x as Error);
    expect(err).toBeInstanceOf(WrongPassphraseError);
    expect(err.message).toMatch(/incorrect passphrase/i);
    expect(err.message).not.toContain("wrong passphrase!");
    expect(locked.isUnlocked).toBe(false);
    expect(await fs.readFile(file)).toEqual(before);
    expect(statSync(file).mtimeMs).toBe(mtime);

    // Wrong passphrase on an already-unlocked session keeps the session intact.
    await expect(v.unlock("nope nope nope")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(v.isUnlocked).toBe(true);
  });

  it("detects tampering with wallet metadata", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    await v.generate("evm");
    const j = JSON.parse(await fs.readFile(file, "utf8"));
    j.wallets[0].address = ANVIL0_ADDR;
    await fs.writeFile(file, JSON.stringify(j));
    await expect((await WalletVault.open(file)).unlock(PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("refuses to create over an existing keystore", async () => {
    await WalletVault.create(file, PASS, FAST);
    await expect(WalletVault.create(file, PASS, FAST)).rejects.toMatchObject({ code: "EXISTS" });
    await expect(WalletVault.create(path.join(dir, "x"), "short", FAST)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enforces MAX_WALLETS_PER_JOB", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const refs = [];
    for (let i = 0; i < MAX_WALLETS_PER_JOB; i++) refs.push(await v.generate(i % 2 ? "evm" : "solana"));
    await expect(v.generate("evm")).rejects.toMatchObject({ code: "VAULT_FULL" });
    await expect(v.importEvm(ANVIL0_KEY)).rejects.toMatchObject({ code: "VAULT_FULL" });
    expect(v.size).toBe(10);
    expect(() => v.signers([...refs.map((r) => r.id), refs[0]!.id])).toThrow(/At most 10/);
    expect(() => v.signers([refs[0]!.id, refs[0]!.id])).toThrow(/Duplicate/);
    expect(v.signers(refs.map((r) => r.id))).toHaveLength(10);
  });

  it("concurrent generates are serialized and all persisted", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const refs = await Promise.all(Array.from({ length: 6 }, (_, i) => v.generate(i % 2 ? "evm" : "solana")));
    const reopened = await WalletVault.open(file);
    expect(reopened.list().map((r) => r.id).sort()).toEqual(refs.map((r) => r.id).sort());
    await reopened.unlock(PASS);
  });

  it("labels, lock/unlock, and signers that stop working when locked", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const e = await v.importEvm(ANVIL0_KEY);
    const renamed = await v.setLabel(e.id, "Main");
    expect(renamed.label).toBe("Main");
    await expect(v.setLabel(e.id, "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const signer = v.signer(e.id);
    v.lock();
    expect(v.isUnlocked).toBe(false);
    expect(v.list()[0]!.label).toBe("Main");
    await expect(signer.signTransaction(new Uint8Array([1]))).rejects.toBeInstanceOf(VaultLockedError);
    await expect(v.generate("evm")).rejects.toBeInstanceOf(VaultLockedError);
    await expect(v.setLabel(e.id, "x")).rejects.toBeInstanceOf(VaultLockedError);
    await v.unlock(PASS);
    const tx: TransactionSerializableEIP1559 = {
      type: "eip1559", chainId: 8453, nonce: 0, to: ANVIL0_ADDR, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    };
    const signed = await signer.signTransaction(hexToBytes(serializeTransaction(tx)));
    expect(await recoverTransactionAddress({ serializedTransaction: toHex(signed) as `0x02${string}` })).toBe(ANVIL0_ADDR);
  });

  it("signs EVM legacy (EIP-155) transactions", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const e = await v.importEvm(ANVIL0_KEY);
    const unsigned = serializeTransaction({ type: "legacy", chainId: 1, nonce: 3, to: ANVIL0_ADDR, value: 5n, gas: 21000n, gasPrice: 10n });
    const signed = toHex(await v.signer(e.id).signTransaction(hexToBytes(unsigned)));
    const parsed = parseTransaction(signed);
    expect(parsed.v).toBeGreaterThanOrEqual(37n);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(ANVIL0_ADDR);
    await expect(v.signer(e.id).signTransaction(hexToBytes(signed))).rejects.toMatchObject({ code: "SIGNING" });
  });

  it("signs Solana messages and partially-signed wire transactions with a verifiable signature", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const s = await v.generate("solana");
    const compiled = solanaTransferMessage(s.address);
    const msgBytes = new Uint8Array(compiled.messageBytes);

    const wire = await v.signer(s.id).signTransaction(msgBytes);
    const decoded = getTransactionDecoder().decode(wire);
    const sig = decoded.signatures[address(s.address)];
    expect(sig).toBeTruthy();
    const kpPub = await crypto.subtle.importKey("raw", (await import("@solana/kit")).getAddressEncoder().encode(address(s.address)) as Uint8Array<ArrayBuffer>, "Ed25519", true, ["verify"]);
    expect(await verifySignature(kpPub, sig as SignatureBytes, msgBytes)).toBe(true);

    // Re-signing the wire form (empty or filled slot) yields the same deterministic ed25519 signature.
    expect(await v.signer(s.id).signTransaction(wire)).toEqual(wire);

    const other = await v.generate("solana");
    await expect(v.signer(other.id).signTransaction(msgBytes)).rejects.toMatchObject({ code: "SIGNING" });
    await expect(v.signer(s.id).signTransaction(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "SIGNING" });
  });

  it("lock() during an in-flight unlock() wins", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    await v.generate("evm");
    v.lock();
    const pending = v.unlock(PASS);
    v.lock();
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError);
    expect(v.isUnlocked).toBe(false);
  });

  it("lock() during an in-flight generate() never writes a zero-key keystore", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const pending = v.generate("solana");
    v.lock();
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError);
    const reopened = await WalletVault.open(file);
    await reopened.unlock(PASS);
    expect(reopened.size).toBe(0);
  });

  it("rejects pre-EIP-155 legacy txs, base58 addresses as secrets, and absurd scrypt params", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const e = await v.importEvm(ANVIL0_KEY);
    const noChain = serializeTransaction({ type: "legacy", nonce: 0, to: ANVIL0_ADDR, value: 1n, gas: 21000n, gasPrice: 1n });
    await expect(v.signer(e.id).signTransaction(hexToBytes(noChain))).rejects.toMatchObject({ code: "SIGNING" });
    await expect(v.importSolana("11111111111111111111111111111112")).rejects.toMatchObject({ code: "INVALID_KEY" });

    const j = JSON.parse(await fs.readFile(file, "utf8"));
    j.kdf.N = 2 ** 30;
    await fs.writeFile(file, JSON.stringify(j));
    await expect(WalletVault.open(file)).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(WalletVault.create(path.join(dir, "y"), PASS, { scrypt: { N: 1000, r: 8, p: 1 } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("signer.wallet reflects label changes", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const e = await v.generate("evm", "old");
    const signer = v.signer(e.id);
    await v.setLabel(e.id, "new");
    expect(signer.wallet.label).toBe("new");
  });

  it("balance reads reject family mismatch", async () => {
    const v = await WalletVault.create(file, PASS, FAST);
    const s = await v.generate("solana");
    await expect(v.getBalance(s.id, "base", "http://127.0.0.1:1")).rejects.toMatchObject({ code: "FAMILY_MISMATCH" });
    expect(await v.getBalances(s.id, [{ chain: "base", rpcUrl: "http://127.0.0.1:1" }])).toEqual({});
  });
});
