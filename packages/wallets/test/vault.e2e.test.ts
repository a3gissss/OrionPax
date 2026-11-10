// E2E: 10-wallet vault (5 Solana + 5 EVM) against local chains only.
// Env: E2E_SOLANA_RPC (default http://127.0.0.1:8899), E2E_BASE_RPC (default http://127.0.0.1:8546).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  address, appendTransactionMessageInstruction, compileTransaction, createSolanaRpc, createTransactionMessage,
  getBase58Decoder, lamports, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature, type Base64EncodedWireTransaction,
} from "@solana/kit";
import {
  createPublicClient, createTestClient, hexToBytes, http, keccak256, parseEther, serializeTransaction, toHex,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { WalletVault, WrongPassphraseError } from "../src/index.js";

const SOLANA_RPC = process.env.E2E_SOLANA_RPC ?? "http://127.0.0.1:8899";
const BASE_RPC = process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546";
for (const u of [SOLANA_RPC, BASE_RPC]) {
  const host = new URL(u).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`e2e must target local chains only (got ${host})`);
}

const PASS = "e2e local-only passphrase";
const SINK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address; // anvil default account #1
const sol = createSolanaRpc(SOLANA_RPC);
const evm = createPublicClient({ chain: { ...base, rpcUrls: { default: { http: [BASE_RPC] } } }, transport: http(BASE_RPC) });
const anvil = createTestClient({ mode: "anvil", transport: http(BASE_RPC) });

let dir: string;
let vault: WalletVault;

async function until<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function waitSolana(sig: string): Promise<void> {
  await until(async () => {
    const { value } = await sol.getSignatureStatuses([toSignature(sig)]).send();
    const st = value[0];
    if (st?.err) throw new Error(`tx ${sig} failed`);
    return st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") ? true : undefined;
  }, `solana tx ${sig}`);
}

beforeAll(async () => {
  await until(async () => ((await sol.getHealth().send()) === "ok" ? true : undefined), "solana validator", 120_000);
  await until(async () => (await evm.getChainId()) === 8453 || undefined, "base anvil");
  dir = await fs.mkdtemp(path.join(tmpdir(), "vault-e2e-"));
  vault = await WalletVault.create(path.join(dir, "vault.keystore"), PASS, { scrypt: { N: 2 ** 14, r: 8, p: 1 } });
  for (let i = 0; i < 5; i++) await vault.generate("solana", `sol-${i}`);
  for (let i = 0; i < 5; i++) await vault.generate("evm", `evm-${i}`);
}, 180_000);

afterAll(async () => {
  vault?.lock();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("wallet vault e2e (local solana + base)", () => {
  it("holds 10 wallets and survives lock / reopen / unlock", async () => {
    expect(vault.size).toBe(10);
    vault.lock();
    const reopened = await WalletVault.open(vault.path);
    await expect(reopened.unlock("not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
    await reopened.unlock(PASS);
    expect(reopened.list()).toEqual(vault.list());
    await vault.unlock(PASS);
    expect(vault.isUnlocked).toBe(true);
  });

  it("reads balances after funding, and each Solana wallet signs + lands a real transfer", async () => {
    const sols = vault.list().filter((w) => w.family === "solana");
    const airdrops = await Promise.all(sols.map((w) => sol.requestAirdrop(address(w.address), lamports(2_000_000_000n)).send()));
    await Promise.all(airdrops.map((s) => waitSolana(s)));
    for (const w of sols) {
      expect(await vault.getBalance(w.id, "solana", SOLANA_RPC)).toBe("2000000000");
      expect(await vault.getBalances(w.id, [{ chain: "solana", rpcUrl: SOLANA_RPC }, { chain: "base", rpcUrl: BASE_RPC }]))
        .toEqual({ solana: "2000000000" });
    }

    const { value: bh } = await sol.getLatestBlockhash({ commitment: "confirmed" }).send();
    const signatures = await Promise.all(sols.map(async (w, i) => {
      const to = sols[(i + 1) % sols.length]!.address;
      const data = new Uint8Array(12);
      const dv = new DataView(data.buffer);
      dv.setUint32(0, 2, true); // SystemProgram::Transfer
      dv.setBigUint64(4, 1_000_000n, true);
      const compiled = compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(w.address), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m) => appendTransactionMessageInstruction({
          programAddress: address("11111111111111111111111111111111"),
          accounts: [{ address: address(w.address), role: 3 }, { address: address(to), role: 1 }],
          data,
        }, m),
      ));
      const wire = await vault.signer(w.id).signTransaction(new Uint8Array(compiled.messageBytes));
      const expectedSig = getBase58Decoder().decode(wire.subarray(1, 65));
      const sent = await sol.sendTransaction(Buffer.from(wire).toString("base64") as Base64EncodedWireTransaction, { encoding: "base64" }).send();
      expect(sent).toBe(expectedSig);
      return sent as string;
    }));
    expect(new Set(signatures).size).toBe(5);
    await Promise.all(signatures.map((s) => waitSolana(s)));
    for (const w of sols) {
      // Each wallet sent 1_000_000 and received 1_000_000; it paid exactly one 5000-lamport fee.
      expect(await vault.getBalance(w.id, "solana", SOLANA_RPC)).toBe(String(2_000_000_000 - 5000));
    }
  }, 180_000);

  it("reads balances after funding, and each EVM wallet signs + lands a real transfer on base", async () => {
    const evms = vault.list().filter((w) => w.family === "evm");
    for (const w of evms) await anvil.setBalance({ address: w.address as Address, value: parseEther("1") });
    for (const w of evms) expect(await vault.getBalance(w.id, "base", BASE_RPC)).toBe(parseEther("1").toString());

    const block = await evm.getBlock();
    const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000_000n) * 2n + 1_000_000n;
    const sinkBefore = await evm.getBalance({ address: SINK });
    const hashes = await Promise.all(evms.map(async (w) => {
      const unsigned = serializeTransaction({
        type: "eip1559", chainId: 8453, nonce: await evm.getTransactionCount({ address: w.address as Address }),
        to: SINK, value: 12345n, gas: 21_000n, maxFeePerGas, maxPriorityFeePerGas: 1_000_000n,
      });
      const signed = await vault.signer(w.id).signTransaction(hexToBytes(unsigned));
      const hash = await evm.sendRawTransaction({ serializedTransaction: toHex(signed) });
      expect(hash).toBe(keccak256(signed));
      return hash;
    }));
    expect(new Set(hashes).size).toBe(5);
    const receipts = await Promise.all(hashes.map((hash) => evm.waitForTransactionReceipt({ hash, timeout: 60_000 })));
    receipts.forEach((r, i) => {
      expect(r.status).toBe("success");
      expect(r.from.toLowerCase()).toBe(evms[i]!.address.toLowerCase());
    });
    expect(await evm.getBalance({ address: SINK })).toBe(sinkBefore + 5n * 12345n);
    for (const [i, w] of evms.entries()) {
      const r = receipts[i]!;
      expect(BigInt(await vault.getBalance(w.id, "base", BASE_RPC))).toBe(parseEther("1") - 12345n - r.gasUsed * r.effectiveGasPrice);
    }
  }, 180_000);

  it("signers refuse to sign after lock", async () => {
    const [w] = vault.list();
    const signer = vault.signer(w!.id);
    vault.lock();
    await expect(signer.signTransaction(new Uint8Array(10))).rejects.toMatchObject({ code: "LOCKED" });
  });
});
