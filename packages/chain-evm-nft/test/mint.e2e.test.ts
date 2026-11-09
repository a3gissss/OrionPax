// E2E against LOCAL anvil chains only (base-like + robinhood-like). Uses anvil's well-known dev mnemonic.
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient, createWalletClient, http, parseEther, parseTransaction,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { ChainConfig, NftMintTarget, WalletRef } from "@mint-engine/core";
import { EvmNftAdapter, MintLimitError, withNonce } from "../src/index.js";
import { compileFixtures, type Compiled } from "./fixtures/compile.js";

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const deployer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i + 1 }));
const wallets: WalletRef[] = accounts.map((a, i) => ({ id: `w${i + 1}`, label: `Wallet ${i + 1}`, family: "evm", address: a.address }));

const CHAINS: Array<{ name: string; config: ChainConfig }> = [
  { name: "base", config: { chain: "base", rpcUrl: process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546", evmChainId: 8453 } },
  // Robinhood: no evmChainId → the adapter reads it from the RPC.
  { name: "robinhood", config: { chain: "robinhood", rpcUrl: process.env.E2E_ROBINHOOD_RPC ?? "http://127.0.0.1:8547" } },
];

const MAX_U64 = 2n ** 64n - 1n;
const MAX_U48 = 2n ** 48n - 1n;

let artifacts: Record<string, Compiled>;
beforeAll(() => { artifacts = compileFixtures(); });

function art(name: string): Compiled {
  const a = artifacts[name];
  if (!a) throw new Error(`missing artifact ${name}`);
  return a;
}

describe.each(CHAINS)("EVM NFT adapter on $name (local anvil)", ({ config }) => {
  let client: PublicClient;
  let deploy: (name: string, args?: unknown[]) => Promise<Address>;
  let write: (address: Address, abi: Abi, functionName: string, args: unknown[]) => Promise<void>;

  beforeAll(async () => {
    client = createPublicClient({ transport: http(config.rpcUrl) });
    const chainId = await client.getChainId();
    const chain = { id: chainId, name: config.chain, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } };
    const wc = createWalletClient({ account: deployer, chain, transport: http(config.rpcUrl) });
    deploy = async (name, args = []) => {
      const a = art(name);
      const hash = await wc.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed`);
      return r.contractAddress;
    };
    write = async (address, abi, functionName, args) => {
      const hash = await wc.writeContract({ address, abi, functionName, args });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${functionName} failed`);
    };
  });

  /** Sign each prepared tx with the wallet's local account and send directly with its next nonce. */
  async function signAndSend(prepared: Array<{ unsigned: Uint8Array }>): Promise<Hex[]> {
    return Promise.all(prepared.map(async (p, i) => {
      const account = accounts[i]!;
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      const unsigned = withNonce(p.unsigned, nonce);
      const tx = parseTransaction(`0x${Buffer.from(unsigned).toString("hex")}`);
      const signed = await account.signTransaction(tx);
      return client.sendRawTransaction({ serializedTransaction: signed });
    }));
  }

  async function expectReceipts(hashes: Hex[]) {
    const receipts = await Promise.all(hashes.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 60_000 })));
    expect(receipts).toHaveLength(10);
    for (const r of receipts) expect(r.status).toBe("success");
  }

  it("ERC721A-style: detects, refuses qty 3, simulate decodes inactive-sale revert, mints 2 x 10 wallets", async () => {
    const price = parseEther("0.01");
    const nft = await deploy("PublicMint721", [price, 2n, 100n]);
    const abi = art("PublicMint721").abi;
    const adapter = new EvmNftAdapter(config);
    const t = (quantity: number): NftMintTarget => ({ kind: "nft", chain: config.chain, address: nft, quantity });

    const before = await adapter.detect(t(2));
    expect(before).toMatchObject({ live: false, detectedStyle: "erc721a", pricePerUnit: price.toString(), maxPerWallet: 2, remainingSupply: 100 });

    // Not live yet: prepare still works (fallback gas) and simulate surfaces the decoded revert.
    const early = await adapter.prepare(t(1), wallets[0]!, {});
    expect(await adapter.simulate(early)).toEqual({ ok: false, error: "Sale not active" });

    await expect(adapter.prepare(t(3), wallets[0]!, {})).rejects.toBeInstanceOf(MintLimitError);

    await write(nft, abi, "setSaleActive", [true]);
    expect((await adapter.detect(t(2))).live).toBe(true);

    const prepared = await Promise.all(wallets.map((w) => adapter.prepare(t(2), w, {})));
    for (const p of prepared) {
      expect(p.value).toBe((price * 2n).toString());
      expect((await adapter.simulate(p)).ok).toBe(true);
    }
    await expectReceipts(await signAndSend(prepared));

    for (const a of accounts) {
      expect(await client.readContract({ address: nft, abi, functionName: "balanceOf", args: [a.address] })).toBe(2n);
    }
    expect(await client.readContract({ address: nft, abi, functionName: "totalSupply" })).toBe(20n);
    // Wallet limit now exhausted: even qty 1 is refused.
    await expect(adapter.prepare(t(1), wallets[0]!, {})).rejects.toThrow(/already minted 2/);
  });

  it("Zora-1155-like fixed price: detects and mints 2 x 10 wallets", async () => {
    const strategy = await deploy("FixedPriceStrategy");
    const token = await deploy("Simple1155");
    const price = parseEther("0.001");
    await write(token, art("Simple1155").abi, "setupToken", [1n, 1000n, strategy, {
      saleStart: 0n, saleEnd: MAX_U64, maxTokensPerAddress: 2n, pricePerToken: price, fundsRecipient: deployer.address,
    }]);
    const adapter = new EvmNftAdapter(config, { zoraFixedPriceStrategy: strategy });
    const t = (quantity: number): NftMintTarget => ({ kind: "nft", chain: config.chain, address: token, quantity, tokenId: "1" });

    const unit = price + parseEther("0.000777");
    expect(await adapter.detect(t(2))).toMatchObject({
      live: true, detectedStyle: "zora-1155", pricePerUnit: unit.toString(), maxPerWallet: 2, remainingSupply: 1000,
    });
    await expect(adapter.prepare(t(3), wallets[0]!, {})).rejects.toBeInstanceOf(MintLimitError);

    const prepared = await Promise.all(wallets.map((w) => adapter.prepare(t(2), w, {})));
    await expectReceipts(await signAndSend(prepared));
    for (const a of accounts) {
      expect(await client.readContract({
        address: token, abi: art("Simple1155").abi, functionName: "balanceOf", args: [a.address, 1n],
      })).toBe(2n);
    }
  });

  it("SeaDrop-like: detects and mints 1 x 10 wallets via mintPublic", async () => {
    const seaDrop = await deploy("MiniSeaDrop");
    const price = parseEther("0.002");
    const nft = await deploy("MiniSeaDropNFT", [seaDrop, 50n, {
      mintPrice: price, startTime: 0, endTime: Number(MAX_U48), maxTotalMintableByWallet: 2, feeBps: 0, restrictFeeRecipients: false,
    }]);
    const adapter = new EvmNftAdapter(config, { seaDropAddress: seaDrop });
    const t = (quantity: number): NftMintTarget => ({ kind: "nft", chain: config.chain, address: nft, quantity });

    expect(await adapter.detect(t(1))).toMatchObject({
      live: true, detectedStyle: "seadrop", pricePerUnit: price.toString(), maxPerWallet: 2, remainingSupply: 50,
    });
    await expect(adapter.prepare(t(3), wallets[0]!, {})).rejects.toBeInstanceOf(MintLimitError);

    const prepared = await Promise.all(wallets.map((w) => adapter.prepare(t(1), w, {})));
    await expectReceipts(await signAndSend(prepared));
    for (const a of accounts) {
      expect(await client.readContract({
        address: nft, abi: art("MiniSeaDropNFT").abi, functionName: "balanceOf", args: [a.address],
      })).toBe(1n);
    }
  });
});
