import { describe, expect, it } from "vitest";
import {
  encodeErrorResult, encodeFunctionData, parseAbi, parseTransaction, toFunctionSelector, type Hex, type PublicClient,
} from "viem";
import type { NftMintTarget, WalletRef } from "@mint-engine/core";
import { EvmNftAdapter, MintLimitError, decodeRevertData, hasSelector, withNonce } from "../src/index.js";
import { coerceArgs, eip1167Target, parseCustomFunction, slotToAddress } from "../src/util.js";

const NFT = "0x1000000000000000000000000000000000000001";
const wallet: WalletRef = { id: "w1", label: "Wallet 1", family: "evm", address: "0x2000000000000000000000000000000000000002" };
const target = (q: number, extra: Partial<NftMintTarget> = {}): NftMintTarget =>
  ({ kind: "nft", chain: "base", address: NFT, quantity: q, ...extra });

const push4 = (sig: string) => `63${toFunctionSelector(sig).slice(2)}`;

/** In-memory stand-in for the subset of viem's PublicClient the adapter uses. */
function fakeClient(o: { saleActive?: boolean; minted?: bigint; estimateFails?: Hex } = {}) {
  const getters: Record<string, unknown> = {
    price: 10n ** 16n, maxPerWallet: 2n, saleActive: o.saleActive ?? true, maxSupply: 100n, totalSupply: 5n,
    numberMinted: o.minted ?? 0n,
  };
  const calls: string[] = [];
  const client = {
    getCode: async () => `0x6080${push4("mint(uint256)")}${push4("price()")}00` as Hex,
    getStorageAt: async () => `0x${"0".repeat(64)}` as Hex,
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName in getters) return getters[functionName];
      throw new Error("execution reverted");
    },
    estimateGas: async () => {
      if (o.estimateFails) throw Object.assign(new Error("reverted"), { data: o.estimateFails });
      return 100_000n;
    },
    call: async () => {
      if (o.estimateFails) throw Object.assign(new Error("reverted"), { cause: { data: o.estimateFails } });
      return { data: "0x" };
    },
    getBlock: async () => ({ timestamp: 1_700_000_000n, baseFeePerGas: 1_000_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 100_000_000n,
    getChainId: async () => 8453,
  };
  return { client: client as unknown as PublicClient, calls };
}

const cfg = { chain: "base" as const, rpcUrl: "http://127.0.0.1:1", evmChainId: 8453 };

describe("util", () => {
  it("probes PUSH4 selectors in bytecode", () => {
    const code = `0x6080${push4("publicMint(uint256)")}` as Hex;
    expect(hasSelector(code, "publicMint(uint256)")).toBe(true);
    // Same bytes hidden inside PUSH data are not a dispatcher entry.
    expect(hasSelector(`0x7f${push4("mint(uint256)")}${"00".repeat(27)}` as Hex, "mint(uint256)")).toBe(false);
    expect(hasSelector(code, "mint(uint256)")).toBe(false);
    expect(hasSelector("0x", "mint(uint256)")).toBe(false);
  });

  it("resolves EIP-1167 clones and storage slots", () => {
    const impl = "0xbebebebebebebebebebebebebebebebebebebebe";
    const code = `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(eip1167Target(code)?.toLowerCase()).toBe(impl);
    expect(eip1167Target("0x6080")).toBeUndefined();
    expect(slotToAddress(`0x000000000000000000000000${impl.slice(2)}`)?.toLowerCase()).toBe(impl);
    expect(slotToAddress(`0x${"0".repeat(64)}`)).toBeUndefined();
  });

  it("parses custom signatures and coerces placeholders", () => {
    const fn = parseCustomFunction("mintTo(address to, uint256 qty)");
    expect(fn.name).toBe("mintTo");
    expect(coerceArgs(fn, ["$wallet", "$quantity"], { quantity: 2, wallet: wallet.address as Hex })).toEqual([wallet.address, 2n]);
    expect(() => coerceArgs(fn, [1], { quantity: 1, wallet: wallet.address as Hex })).toThrow(/expects 2 args/);
  });

  it("decodes Error(string) and known custom errors", () => {
    const strErr = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Sale not active"] });
    expect(decodeRevertData(strErr)).toBe("Sale not active");
    const custom = encodeErrorResult({
      abi: parseAbi(["error NotActive(uint256,uint256,uint256)"]), errorName: "NotActive", args: [1n, 2n, 3n],
    });
    expect(decodeRevertData(custom)).toBe("NotActive(1, 2, 3)");
    expect(decodeRevertData("0xdeadbeef")).toMatch(/unknown error 0xdeadbeef/);
  });

  it("withNonce re-serializes the unsigned tx", () => {
    const { client } = fakeClient();
    return new EvmNftAdapter(cfg, { client }).prepare(target(1), wallet, {}).then((tx) => {
      const re = withNonce(tx.unsigned, 7);
      const parsed = parseTransaction(`0x${Buffer.from(re).toString("hex")}`);
      expect(parsed.nonce).toBe(7);
      expect(parsed.value).toBe(10n ** 16n);
    });
  });
});

describe("EvmNftAdapter (fake client)", () => {
  it("supports only nft targets on its own chain", () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    expect(a.supports(target(1))).toBe(true);
    expect(a.supports({ ...target(1), chain: "ethereum" })).toBe(false);
    expect(a.supports({ ...target(1), style: "core-candy-machine" })).toBe(false);
    expect(a.supports({ kind: "token", chain: "base", tokenAddress: NFT, launchpadAddress: NFT, spendPerWallet: "1", slippageBps: 1 })).toBe(false);
    expect(() => new EvmNftAdapter({ chain: "solana", rpcUrl: "x" })).toThrow();
  });

  it("detects an ERC721A-style mint", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    expect(await a.detect(target(1))).toEqual({
      live: true, pricePerUnit: (10n ** 16n).toString(), maxPerWallet: 2, remainingSupply: 95, detectedStyle: "erc721a",
    });
  });

  it("prepares an EIP-1559 tx with value, gas x1.15 and nonce placeholder", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    const tx = await a.prepare(target(2), wallet, { priorityFee: "2000000000" });
    const parsed = parseTransaction(`0x${Buffer.from(tx.unsigned).toString("hex")}`);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(8453);
    expect(parsed.nonce).toBe(0);
    expect(parsed.gas).toBe(115_000n);
    expect(parsed.value).toBe(2n * 10n ** 16n);
    expect(parsed.maxPriorityFeePerGas).toBe(2_000_000_000n);
    expect(parsed.maxFeePerGas).toBe(2n * 1_000_000_000n + 2_000_000_000n);
    expect(parsed.data).toBe(encodeFunctionData({ abi: parseAbi(["function mint(uint256)"]), args: [2n] }));
    expect(tx.value).toBe((2n * 10n ** 16n).toString());
    expect(tx.computeOrGas).toBe(115_000);
  });

  it("uses the nonce provider when given and respects maxTotalFee", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client, nonceProvider: () => 42 });
    const tx = await a.prepare(target(1), wallet, { maxTotalFee: (115_000n * 1_500_000_000n).toString() });
    const parsed = parseTransaction(`0x${Buffer.from(tx.unsigned).toString("hex")}`);
    expect(parsed.nonce).toBe(42);
    expect(parsed.maxFeePerGas).toBe(1_500_000_000n);
    await expect(a.prepare(target(1), wallet, { maxTotalFee: "1" })).rejects.toThrow(/below current base fee/);
  });

  it("refuses quantity above the per-wallet limit, counting prior mints", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    await expect(a.prepare(target(3), wallet, {})).rejects.toBeInstanceOf(MintLimitError);
    const b = new EvmNftAdapter(cfg, { client: fakeClient({ minted: 1n }).client });
    await expect(b.prepare(target(2), wallet, {})).rejects.toThrow(/already minted 1/);
    await expect(b.prepare(target(1), wallet, {})).resolves.toBeTruthy();
  });

  it("prepares with fallback gas before the sale is live, and simulate decodes the revert", async () => {
    const revert = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Sale not active"] });
    const a = new EvmNftAdapter(cfg, { client: fakeClient({ saleActive: false, estimateFails: revert }).client });
    expect((await a.detect(target(1))).live).toBe(false);
    const tx = await a.prepare(target(1), wallet, {});
    expect(tx.computeOrGas).toBe(300_000);
    expect(await a.simulate(tx)).toEqual({ ok: false, error: "Sale not active" });
  });

  it("throws with the decoded reason when a live mint would revert", async () => {
    const revert = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Wrong value"] });
    const a = new EvmNftAdapter(cfg, { client: fakeClient({ estimateFails: revert }).client });
    await expect(a.prepare(target(1), wallet, {})).rejects.toThrow(/Wrong value/);
  });

  it("encodes custom functions with placeholders", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    const tx = await a.prepare(target(1, {
      style: "custom", customFunction: { signature: "function claim(address to, uint256 qty) payable", args: ["$wallet", "$quantity"] },
    }), wallet, {});
    const parsed = parseTransaction(`0x${Buffer.from(tx.unsigned).toString("hex")}`);
    expect(parsed.data).toBe(encodeFunctionData({
      abi: parseAbi(["function claim(address,uint256)"]), args: [wallet.address as Hex, 1n],
    }));
    expect(parsed.value).toBe(10n ** 16n);
  });

  it("simulate reports unknown wallets", async () => {
    const a = new EvmNftAdapter(cfg, { client: fakeClient().client });
    const tx = await a.prepare(target(1), wallet, {});
    const res = await a.simulate({ ...tx, walletId: "nope" });
    expect(res.ok).toBe(false);
    expect(await a.simulate(tx)).toEqual({ ok: true, computeOrGasUsed: 100_000 });
  });
});
