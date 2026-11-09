// E2E against a LOCAL anvil only (docker `eth` service, chain id 1). Never point at mainnet.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedTx, WalletSigner } from "@mint-engine/core";
import {
  bytesToHex,
  createPublicClient,
  hexToBytes,
  http,
  keccak256,
  parseTransaction,
  recoverMessageAddress,
  serializeTransaction,
  toHex,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EvmL1Router, NonceManager, feeStrategyFor, isNonceError, patchPrepared } from "../src/index.js";

const RPC = process.env.E2E_ETH_RPC ?? "http://127.0.0.1:8545";

// Anvil's well-known default dev keys (local test chains only).
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

const accounts = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
const client = createPublicClient({ transport: http(RPC) });

/** Test-only signer mirroring the wallets package contract: unsigned bytes in, signed bytes out. */
function localSigner(i: number): WalletSigner {
  const acct = accounts[i]!;
  return {
    wallet: { id: `w${i}`, label: `Wallet ${i}`, family: "evm", address: acct.address },
    async signTransaction(unsigned) {
      const tx = parseTransaction(bytesToHex(unsigned)) as TransactionSerializableEIP1559;
      return hexToBytes(await acct.signTransaction(tx));
    },
  };
}
const signers = accounts.map((_, i) => localSigner(i));

/** What a chain adapter would hand over: unsigned self-transfer with placeholder nonce/fees. */
function prepareSelfTransfer(i: number): PreparedTx {
  const unsigned = serializeTransaction({
    type: "eip1559", chainId: 1, nonce: 0, to: accounts[i]!.address, value: 1n, gas: 21000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n,
  });
  return { chain: "ethereum", walletId: `w${i}`, unsigned: hexToBytes(unsigned), value: "1", computeOrGas: 21000, description: `self-transfer w${i}` };
}

const nonces = new NonceManager(client);
const fees = { priorityFee: String(2_000_000_000n) };

async function buildSigned(i: number, nonceOverride?: number) {
  const signer = signers[i]!;
  const prepared = prepareSelfTransfer(i);
  const block = await client.getBlock({ blockTag: "latest" });
  const f = feeStrategyFor(block, fees, { gasLimit: prepared.computeOrGas });
  const nonce = nonceOverride ?? (await nonces.reserve(signer.wallet.address));
  try {
    const patched = patchPrepared(prepared, { nonce, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas });
    return { prepared: patched, signed: await signer.signTransaction(patched.unsigned), nonce };
  } catch (e) {
    if (nonceOverride === undefined) await nonces.release(signer.wallet.address, nonce);
    throw e;
  }
}

// ---------- local stub relay / builder ----------

interface Recorded { path: string; method: string; headers: IncomingHttpHeaders; body: string }
const recorded: Recorded[] = [];
let stub: Server;
let stubUrl = "";

async function forward(body: string): Promise<string> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  return res.text();
}

beforeAll(async () => {
  await client.getChainId(); // fail fast if anvil is down
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const j = JSON.parse(body);
      recorded.push({ path: req.url ?? "/", method: j.method, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (j.method === "eth_sendBundle") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { bundleHash: keccak256(toHex(body)) } }));
      } else if (j.method === "eth_sendRawTransaction") {
        res.end(await forward(body));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "method not found" } }));
      }
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
});

describe("router-evm-l1 e2e (local anvil)", () => {
  it("public path: 10 wallets, fan-out send, 10 confirmed", async () => {
    const router = new EvmL1Router({ config: { chain: "ethereum", rpcUrl: RPC, extraRpcUrls: [RPC] }, pollIntervalMs: 200 });
    const signed = await Promise.all(signers.map((_, i) => buildSigned(i)));
    const sent = await router.send(signed, fees);
    expect(sent).toHaveLength(10);
    for (const s of sent) expect(s.via.length).toBeGreaterThan(0);
    const out = await router.confirm(sent, { timeoutMs: 30_000 });
    expect(out.map((o) => o.status)).toEqual(Array(10).fill("confirmed"));
  });

  it("private path: relay + signed bundles to stub, txs land", async () => {
    recorded.length = 0;
    const authKey = generatePrivateKey(); // throwaway auth key, never a wallet
    const router = new EvmL1Router({
      config: { chain: "ethereum", rpcUrl: RPC, privateRelayUrl: `${stubUrl}/relay` },
      bundle: { builderUrls: [`${stubUrl}/builder`], authKey },
      pollIntervalMs: 200,
    });
    const signed = await Promise.all(signers.map((_, i) => buildSigned(i)));
    const sent = await router.send(signed, { ...fees, privateSubmission: true });

    const relayCalls = recorded.filter((r) => r.path === "/relay");
    const bundleCalls = recorded.filter((r) => r.method === "eth_sendBundle");
    expect(relayCalls.every((r) => r.method === "eth_sendRawTransaction")).toBe(true);
    expect(relayCalls).toHaveLength(10);
    expect(bundleCalls).toHaveLength(20); // 10 txs × blocks N, N+1
    const authAddr = privateKeyToAccount(authKey).address;
    for (const c of bundleCalls) {
      const header = c.headers["x-flashbots-signature"];
      expect(typeof header).toBe("string");
      const [addr, sig] = (header as string).split(":");
      expect(addr).toBe(authAddr);
      expect(await recoverMessageAddress({ message: keccak256(toHex(c.body)), signature: sig as Hex })).toBe(authAddr);
    }
    for (const s of sent) expect(s.via).toEqual(expect.arrayContaining([expect.stringMatching(/^relay:/), expect.stringMatching(/^bundle:/)]));

    const out = await router.confirm(sent, { timeoutMs: 30_000 });
    expect(out.map((o) => o.status)).toEqual(Array(10).fill("confirmed"));
  });

  it("nonce release after a signing failure, resync after nonce-too-low", async () => {
    const router = new EvmL1Router({ config: { chain: "ethereum", rpcUrl: RPC }, pollIntervalMs: 200 });
    const addr = accounts[0]!.address;

    // Forced failure before broadcast → release returns the nonce to the pool.
    const before = nonces.peek(addr)!;
    const n = await nonces.reserve(addr);
    await nonces.release(addr, n);
    expect(nonces.peek(addr)).toBe(before);

    // Another process uses the nonce behind our back → our tx is "nonce too low".
    const stale = nonces.peek(addr)!;
    const outside = await buildSigned(0, stale);
    const [outsideSent] = await router.send([outside], fees);
    expect((await router.confirm([outsideSent!], { timeoutMs: 30_000 }))[0]!.status).toBe("confirmed");

    const bad = await buildSigned(0); // manager hands out the stale nonce
    expect(bad.nonce).toBe(stale);
    const [badSent] = await router.send([bad], fees);
    const [badOut] = await router.confirm([badSent!], { timeoutMs: 5_000 });
    expect(badOut!.status).toBe("failed");
    expect(isNonceError(badOut!.error)).toBe(true);

    const fresh = await nonces.resync(addr);
    expect(fresh).toBe(stale + 1);
    const good = await buildSigned(0);
    expect(good.nonce).toBe(fresh);
    const [goodSent] = await router.send([good], fees);
    expect((await router.confirm([goodSent!], { timeoutMs: 30_000 }))[0]!.status).toBe("confirmed");
  });
});
