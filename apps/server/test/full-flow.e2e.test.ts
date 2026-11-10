// Full stack against a real local EVM chain (anvil or Hardhat, chain id 8453):
// vault -> dashboard REST/WS -> engine -> EvmNftAdapter -> beforeSign nonce -> L2Router -> chain.
//
//   E2E_BASE_RPC=http://127.0.0.1:8546 npm run e2e -w @mint-engine/server
//
// Skips itself when the RPC isn't reachable. Local chains only (fixtures refuse remote URLs).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { JobView, WalletView } from "@mint-engine/core";
import { WalletVault } from "@mint-engine/wallets";
import { anvilDevAccounts, deployEvmFixtures, evmChain, fixtureAbis, setErc721aSaleActive } from "@mint-engine/fixtures";
import { createServer, type DashboardServer } from "../src/server.js";
import { createRealBackend } from "../src/real.js";

const RPC = process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546";
const PASS = "full flow e2e passphrase";

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const up = await reachable(RPC);

describe.skipIf(!up)("full flow on a local chain", () => {
  let dir: string;
  let server: DashboardServer;
  let base: string;
  let token: string;
  let nft: Address;
  let wallets: WalletView[];

  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "x-session-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as T };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "me-full-"));
    const chain = await evmChain(RPC);
    const fx = await deployEvmFixtures(RPC, { erc721a: { maxPerWallet: 1n, priceWei: parseEther("0.001") } });
    nft = fx.erc721a.address;
    await setErc721aSaleActive(RPC, nft, true);

    // Vault with 10 fresh EVM wallets, funded from a dev account.
    const vaultPath = join(dir, "wallets.keystore");
    const v = await WalletVault.create(vaultPath, PASS);
    for (let i = 0; i < 10; i++) await v.generate("evm", `E2E ${i + 1}`);
    const funder = privateKeyToAccount(anvilDevAccounts(1)[0]!.privateKey);
    const wc = createWalletClient({ account: funder, chain, transport: http(RPC) });
    const pc = createPublicClient({ chain, transport: http(RPC) });
    for (const w of v.list()) {
      const hash = await wc.sendTransaction({ to: w.address as Address, value: parseEther("1") });
      await pc.waitForTransactionReceipt({ hash });
    }
    v.lock();

    const backend = await createRealBackend({
      vaultPath, ledgerPath: join(dir, "ledger.json"),
      chains: { base: { rpcUrl: RPC, evmChainId: chain.id } },
    });
    server = createServer({ engine: backend.engine, vault: backend.vault, port: 0, log: () => {} });
    const l = await server.listen();
    base = l.url;
    token = server.token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("unlocks the vault and lists 10 funded wallets", async () => {
    expect((await api("GET", "/api/wallets")).status).toBe(423);
    expect((await api("POST", "/api/vault/unlock", { passphrase: PASS })).status).toBe(200);
    const r = await api<WalletView[]>("GET", "/api/wallets");
    expect(r.status).toBe(200);
    wallets = r.json;
    expect(wallets).toHaveLength(10);
    for (const w of wallets) expect(BigInt(w.balances.base ?? "0")).toBe(parseEther("1"));
  });

  it("mints from all 10 wallets in one job, then refuses a second mint (maxPerWallet 1)", async () => {
    const create = await api<JobView>("POST", "/api/jobs", {
      target: { kind: "nft", chain: "base", address: nft, quantity: 1 },
      walletIds: wallets.map((w) => w.id),
      fees: {},
      trigger: { type: "now" },
    });
    expect(create.status).toBe(201);
    const id = create.json.job.id;

    let job: JobView | undefined;
    for (let i = 0; i < 120; i++) {
      job = (await api<JobView[]>("GET", "/api/jobs")).json.find((j) => j.job.id === id);
      if (job && ["done", "failed", "cancelled"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(job?.status).toBe("done");
    const confirmed = job!.outcomes.filter((o) => o.status === "confirmed");
    expect(confirmed).toHaveLength(10);
    expect(new Set(confirmed.map((o) => o.sent.id)).size).toBe(10);

    // On-chain: each wallet holds exactly 1 token.
    const pc = createPublicClient({ transport: http(RPC) });
    for (const w of wallets) {
      const bal = await pc.readContract({ address: nft, abi: fixtureAbis.erc721a, functionName: "balanceOf", args: [w.address as Address] });
      expect(bal).toBe(1n);
    }

    // A second job from the same wallets is refused per wallet (limit reached), nothing re-mints.
    const again = await api<JobView>("POST", "/api/jobs", {
      target: { kind: "nft", chain: "base", address: nft, quantity: 1 },
      walletIds: wallets.slice(0, 2).map((w) => w.id),
      fees: {}, trigger: { type: "now" }, maxRetries: 0,
    });
    let second: JobView | undefined;
    for (let i = 0; i < 60; i++) {
      second = (await api<JobView[]>("GET", "/api/jobs")).json.find((j) => j.job.id === again.json.job.id);
      if (second && ["done", "failed", "cancelled"].includes(second.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(second?.outcomes.filter((o) => o.status === "confirmed")).toHaveLength(0);
    for (const w of wallets.slice(0, 2)) {
      const bal = await pc.readContract({ address: nft, abi: fixtureAbis.erc721a, functionName: "balanceOf", args: [w.address as Address] });
      expect(bal).toBe(1n);
    }
  }, 120_000);
});
