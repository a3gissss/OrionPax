import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as httpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeTransaction } from "viem";
import type { PreparedTx } from "@mint-engine/core";
import { WalletVault } from "@mint-engine/wallets";
import { decodeUnsigned } from "@mint-engine/router-evm-l1";
import { buildAdapters, buildRouters, createRealBackend, loadConfig, makeBeforeSign, type RealConfig } from "../src/real.js";

const PASS = "correct horse battery staple";

let dir: string;
let rpc: Server;
let rpcUrl: string;
const calls: Array<{ method: string; params: unknown[] }> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "me-real-"));
  // Stub JSON-RPC: pending nonce 5 for every address.
  rpc = httpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push({ method, params });
      const result = method === "eth_getTransactionCount" ? "0x5"
        : method === "eth_chainId" ? "0x2105"
        : method === "eth_getBalance" ? "0xde0b6b3a7640000" // 1 ETH
        : null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => rpc.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const cfgFor = (vaultPath: string): RealConfig => ({
  vaultPath,
  ledgerPath: join(dir, "ledger.json"),
  chains: {
    base: { rpcUrl, evmChainId: 8453 },
    robinhood: { rpcUrl, evmChainId: 4663 },
    ethereum: { rpcUrl, evmChainId: 1 },
    solana: { rpcUrl: "http://127.0.0.1:1" },
  },
});

describe("real backend wiring", () => {
  it("loadConfig validates required fields", async () => {
    const p = join(dir, "bad.json");
    await writeFile(p, JSON.stringify({ vaultPath: "x", chains: {} }));
    await expect(loadConfig(p)).rejects.toThrow(/at least one chain/);
    await writeFile(p, JSON.stringify({ vaultPath: "x", chains: { base: {} } }));
    await expect(loadConfig(p)).rejects.toThrow(/rpcUrl/);
    await writeFile(p, JSON.stringify({ vaultPath: "x", chains: { polygon: { rpcUrl: "http://x" } } }));
    await expect(loadConfig(p)).rejects.toThrow(/unknown chain/);
  });

  it("builds an adapter for every chain + kind and one router per chain", () => {
    const cfg = { ...cfgFor("unused"), pumpfunProgramId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" };
    const adapters = buildAdapters(cfg);
    for (const chain of ["solana", "ethereum", "base", "robinhood"] as const) {
      for (const kind of ["nft", "token"] as const) {
        expect(adapters.some((a) => a.chain === chain && a.kind === kind), `${chain}/${kind}`).toBe(true);
      }
    }
    const routed = buildRouters(cfg).flatMap((r) => r.chains).sort();
    expect(routed).toEqual(["base", "ethereum", "robinhood", "solana"]);
    // Without a pump.fun program id, Solana token launches are off.
    expect(buildAdapters(cfgFor("unused")).some((a) => a.chain === "solana" && a.kind === "token")).toBe(false);
  });

  it("beforeSign sets the pending nonce on EVM txs and leaves Solana txs alone", async () => {
    const beforeSign = makeBeforeSign(cfgFor("unused"));
    const unsigned = serializeTransaction({
      type: "eip1559", chainId: 8453, nonce: 0, to: "0x0000000000000000000000000000000000000001",
      value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    });
    const tx: PreparedTx = { chain: "base", walletId: "w1", unsigned: Buffer.from(unsigned.slice(2), "hex"), value: "1", description: "t" };
    const wallet = { id: "w1", label: "W1", family: "evm" as const, address: "0x00000000000000000000000000000000000000aa" };
    const out = await beforeSign(tx, wallet);
    expect(out.nonce).toBe(5);
    expect((decodeUnsigned(out.unsigned) as { nonce?: number }).nonce).toBe(5);
    expect(calls.at(-1)).toEqual({ method: "eth_getTransactionCount", params: [wallet.address, "pending"] });

    const sol: PreparedTx = { chain: "solana", walletId: "s1", unsigned: new Uint8Array([1, 2, 3]), value: "0", description: "s" };
    expect(await beforeSign(sol, { ...wallet, family: "solana" })).toBe(sol);
  });

  it("vault port: unlock with the right/wrong passphrase, list wallets with balances, lock", async () => {
    const vaultPath = join(dir, "v1.keystore");
    const v = await WalletVault.create(vaultPath, PASS);
    await v.generate("evm", "Main");
    v.lock();

    const { vault, engine, restored } = await createRealBackend({ ...cfgFor(vaultPath), chains: { base: { rpcUrl, evmChainId: 8453 } } });
    expect(restored).toEqual([]);
    expect(vault.isUnlocked()).toBe(false);
    expect(await vault.unlock("wrong passphrase!!")).toBe(false);
    expect(await vault.unlock(PASS)).toBe(true);
    const ws = await vault.list();
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ family: "evm", label: "Main" });
    expect(ws[0]!.balances).toEqual({ base: "1000000000000000000" });
    await vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(await engine.cancel("no-such-job")).toBeUndefined();
    expect(engine.list()).toEqual([]);
  });
});
