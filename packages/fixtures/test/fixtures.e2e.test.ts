// E2E against local Docker chains only. URLs: E2E_BASE_RPC / E2E_ROBINHOOD_RPC / E2E_SOLANA_RPC / E2E_SOLANA_WS.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  anvilDevAccounts,
  deployEvmFixtures,
  evmChain,
  evmClients,
  fixtureAbis,
  fundLocalWallets,
  getSolanaBalance,
  localEndpoints,
  setErc721aSaleActive,
  startSolanaFixtures,
} from "../src/index.js";

const ep = localEndpoints();
const WALLETS = 10;

for (const [name, rpcUrl] of [
  ["base", ep.base],
  ["robinhood", ep.robinhood],
] as const) {
  describe(`EVM fixtures on ${name} (${rpcUrl})`, () => {
    it("deploys, enforces maxPerWallet on the ERC721A drop, and buys on the bonding curve from 10 wallets", async () => {
      const fx = await deployEvmFixtures(rpcUrl);
      expect(fx.erc721a.saleActive).toBe(false);
      const chain = await evmChain(rpcUrl);
      const accounts = anvilDevAccounts(WALLETS);
      const clients = accounts.map((a) => evmClients(rpcUrl, chain, a.privateKey));
      const pub = clients[0]!.publicClient;

      // Before the sale: mint reverts with SaleNotActive.
      await expect(
        pub.simulateContract({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, functionName: "mint", args: [1n], value: fx.erc721a.priceWei, account: clients[1]!.account }),
      ).rejects.toThrow(/SaleNotActive/);

      await setErc721aSaleActive(rpcUrl, fx.erc721a.address, true);
      const started = await pub.getContractEvents({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, eventName: "SaleStarted", fromBlock: 0n });
      expect(started).toHaveLength(1);

      // 10 wallets in parallel mint exactly maxPerWallet.
      const q = fx.erc721a.maxPerWallet;
      const hashes = await Promise.all(
        clients.map((c) =>
          c.walletClient.writeContract({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, functionName: "mint", args: [q], value: fx.erc721a.priceWei * q, account: c.account, chain }),
        ),
      );
      const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
      expect(receipts.every((r) => r.status === "success")).toBe(true);
      for (const a of accounts) {
        expect(await pub.readContract({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, functionName: "numberMinted", args: [a.address] })).toBe(q);
      }
      expect(await pub.readContract({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, functionName: "totalSupply" })).toBe(q * BigInt(WALLETS));

      // One more from any wallet exceeds the per-wallet limit.
      await expect(
        pub.simulateContract({ address: fx.erc721a.address, abi: fixtureAbis.erc721a, functionName: "mint", args: [1n], value: fx.erc721a.priceWei, account: clients[3]!.account }),
      ).rejects.toThrow(/ExceedsMaxPerWallet/);

      // Zora-1155-like mint: (price + mintFee) * qty, minterArguments = abi.encode(mintTo, comment).
      {
        const c = clients[4]!;
        const args: Hex = encodeAbiParameters([{ type: "address" }, { type: "string" }], [c.account.address, ""]);
        const value = (fx.zora1155.priceWei + fx.zora1155.mintFeeWei) * 2n;
        const hash = await c.walletClient.writeContract({ address: fx.zora1155.address, abi: fixtureAbis.zora1155, functionName: "mint", args: [fx.zora1155.minter, fx.zora1155.tokenId, 2n, [], args], value, account: c.account, chain });
        expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
        expect(await pub.readContract({ address: fx.zora1155.address, abi: fixtureAbis.zora1155, functionName: "balanceOf", args: [c.account.address, fx.zora1155.tokenId] })).toBe(2n);
      }

      // Bonding curve: each wallet buys 1 ETH with minOut = quote - 1% slippage.
      const spend = 10n ** 18n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // Quotes fall with each buy: the 10th 1-ETH buy gets ~61% of the first quote (30 vETH start), so the burst uses
      // a 50% floor. A real engine would set minOut per wallet from its own slippage budget.
      const quote = await pub.readContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "getBuyQuote", args: [fx.launchpad.token, spend] });
      expect(quote).toBeGreaterThan(0n);
      const minOut = (quote * 50n) / 100n;
      const buys = await Promise.all(
        clients.map((c) =>
          c.walletClient.writeContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "buy", args: [fx.launchpad.token, minOut, deadline], value: spend, account: c.account, chain }),
        ),
      );
      const buyReceipts = await Promise.all(buys.map((hash) => pub.waitForTransactionReceipt({ hash })));
      expect(buyReceipts.every((r) => r.status === "success")).toBe(true);
      for (const a of accounts) {
        const bal = await pub.readContract({ address: fx.launchpad.token, abi: fixtureAbis.launchToken, functionName: "balanceOf", args: [a.address] });
        expect(bal).toBeGreaterThanOrEqual(minOut);
      }
      expect(await pub.readContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "isGraduated", args: [fx.launchpad.token] })).toBe(false);

      // Slippage guard: an impossible minOut reverts.
      await expect(
        pub.simulateContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "buy", args: [fx.launchpad.token, quote * 10n, deadline], value: spend, account: clients[0]!.account }),
      ).rejects.toThrow(/SlippageExceeded/);
    });

    it("graduates the curve once the ETH threshold is reached", async () => {
      const fx = await deployEvmFixtures(rpcUrl, { launchpad: { graduationEthWei: 2n * 10n ** 18n } });
      const chain = await evmChain(rpcUrl);
      const c = evmClients(rpcUrl, chain, anvilDevAccounts(6)[5]!.privateKey);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = await c.walletClient.writeContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "buy", args: [fx.launchpad.token, 0n, deadline], value: 3n * 10n ** 18n, account: c.account, chain });
      await c.publicClient.waitForTransactionReceipt({ hash });
      expect(await c.publicClient.readContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "isGraduated", args: [fx.launchpad.token] })).toBe(true);
      expect(await c.publicClient.readContract({ address: fx.launchpad.address, abi: fixtureAbis.launchpad, functionName: "getBuyQuote", args: [fx.launchpad.token, 10n ** 18n] })).toBe(0n);
    });
  });
}

describe(`Solana validator (${ep.solanaRpc})`, () => {
  it("is reachable and 10 throwaway wallets get airdropped", async () => {
    const sol = await startSolanaFixtures({ rpcUrl: ep.solanaRpc, wsUrl: ep.solanaWs });
    expect(sol.solanaCore).toMatch(/\d+\.\d+/);
    const dir = mkdtempSync(join(tmpdir(), "fixtures-e2e-"));
    try {
      const res = await fundLocalWallets(WALLETS, {
        path: join(dir, ".local-wallets.json"),
        solanaRpcUrl: ep.solanaRpc,
        solanaLamports: 2_000_000_000n,
        evmRpcUrls: [ep.base],
      });
      expect(res.wallets).toHaveLength(WALLETS);
      for (const w of res.wallets) {
        expect(await getSolanaBalance(ep.solanaRpc, w.solana.publicKey)).toBe(2_000_000_000n);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
