import { describe, expect, it } from "vitest";
import {
  createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, hexToBytes,
  parseTransaction, toHex, type Abi, type Address, type Hex,
} from "viem";
import { mockWallets, type TokenLaunchTarget } from "@mint-engine/core";
import {
  ERC20_ABI, EvmTokenAdapter, GENERIC_BONDING_CURVE, LaunchpadRegistry, UNISWAP_V2_ROUTER,
} from "../src/index.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const LAUNCHPAD = "0x00000000000000000000000000000000000000bb" as Address;
const ROUTER = "0x00000000000000000000000000000000000000cc" as Address;
const WETH = "0x00000000000000000000000000000000000000dd" as Address;
const BLOCK_TS = 1_700_000_000n;
const ABI = [...GENERIC_BONDING_CURVE.abi, ...UNISWAP_V2_ROUTER.abi, ...ERC20_ABI] as Abi;

interface FakeChain {
  graduated: boolean;
  /** tokens out per wei */
  rate: bigint;
  revertCalls?: Hex;
  calls: string[];
}

function fakeClient(state: FakeChain) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const p = params as any[];
        switch (method) {
          case "eth_chainId": return "0x2105";
          case "eth_blockNumber": return "0x64";
          case "eth_getBlockByNumber":
            return {
              number: "0x64", timestamp: toHex(BLOCK_TS), baseFeePerGas: "0x3b9aca00", hash: `0x${"11".repeat(32)}`,
              parentHash: `0x${"22".repeat(32)}`, gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
            };
          case "eth_maxPriorityFeePerGas": return "0x5f5e100";
          case "eth_estimateGas":
            if (state.revertCalls) throw Object.assign(new Error("execution reverted"), { code: 3, data: state.revertCalls });
            return "0x186a0"; // 100_000
          case "eth_call": {
            const { data, to } = p[0] as { data: Hex; to: Address };
            if (state.revertCalls) throw Object.assign(new Error("execution reverted"), { code: 3, data: state.revertCalls });
            const { functionName, args } = decodeFunctionData({ abi: ABI, data });
            state.calls.push(`${to}:${functionName}`);
            const res = (() => {
              switch (functionName) {
                case "isGraduated": return state.graduated;
                case "getBuyQuote": return (args![1] as bigint) * state.rate;
                case "decimals": return 18;
                case "WETH": return WETH;
                case "getAmountsOut": return [args![0] as bigint, (args![0] as bigint) * state.rate * 2n];
                default: return undefined;
              }
            })();
            if (functionName === "buy" || functionName === "swapExactETHForTokens") return "0x";
            return encodeFunctionResult({ abi: ABI, functionName, result: res } as any);
          }
          default: throw new Error(`unexpected ${method}`);
        }
      },
    }),
  });
}

const target: TokenLaunchTarget = {
  kind: "token", chain: "base", tokenAddress: TOKEN, launchpadAddress: LAUNCHPAD,
  spendPerWallet: "1000000000000000000", slippageBps: 500,
};
const [wallet] = mockWallets(1);

function adapter(state: FakeChain, extra: Partial<ConstructorParameters<typeof EvmTokenAdapter>[0]> = {}) {
  return new EvmTokenAdapter({ chain: "base", rpcUrl: "http://unused", client: fakeClient(state) as any, ...extra });
}

describe("EvmTokenAdapter", () => {
  it("supports only token targets on its chain", () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    expect(a.kind).toBe("token");
    expect(a.supports(target)).toBe(true);
    expect(a.supports({ ...target, chain: "ethereum" })).toBe(false);
    expect(a.supports({ ...target, tokenAddress: "nope" })).toBe(false);
    expect(a.supports({ kind: "nft", chain: "base", address: TOKEN, quantity: 1 })).toBe(false);
    expect(() => new EvmTokenAdapter({ chain: "solana" as any, rpcUrl: "x" })).toThrow();
  });

  it("detect reports live and price per whole token from the quote", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    const s = await a.detect(target);
    expect(s.live).toBe(true);
    // 1e18 wei buys 1000e18 base units → 1e15 wei per whole token
    expect(s.pricePerUnit).toBe((10n ** 15n).toString());
    expect(s.detectedStyle).toBe("generic-bonding-curve");
  });

  it("prepare builds an EIP-1559 tx with slippage-guarded minOut, 60s deadline and gas ×1.15", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    const tx = await a.prepare(target, wallet!, { priorityFee: "2000000000" });
    const parsed = parseTransaction(toHex(tx.unsigned));
    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(8453);
    expect(parsed.nonce ?? 0).toBe(0);
    expect(parsed.to?.toLowerCase()).toBe(LAUNCHPAD);
    expect(parsed.value).toBe(10n ** 18n);
    expect(parsed.gas).toBe(115_000n);
    expect(parsed.maxPriorityFeePerGas).toBe(2_000_000_000n);
    expect(parsed.maxFeePerGas).toBe(2n * 1_000_000_000n + 2_000_000_000n);
    const { functionName, args } = decodeFunctionData({ abi: GENERIC_BONDING_CURVE.abi, data: parsed.data! });
    expect(functionName).toBe("buy");
    expect((args![0] as string).toLowerCase()).toBe(TOKEN);
    expect(args![1]).toBe((1000n * 10n ** 18n * 9500n) / 10000n);
    expect(args![2]).toBe(BLOCK_TS + 60n);
    expect(tx.value).toBe("1000000000000000000");
    expect(tx.computeOrGas).toBe(115_000);
    expect(tx.validUntil).toBe(100 + 30); // base ≈ 2 s blocks
  });

  it("caps maxFee by maxTotalFee", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    const tx = await a.prepare(target, wallet!, { priorityFee: "100", maxTotalFee: (115_000n * 1_500_000_000n).toString() });
    expect(parseTransaction(toHex(tx.unsigned)).maxFeePerGas).toBe(1_500_000_000n);
    await expect(a.prepare(target, wallet!, { maxTotalFee: "1" })).rejects.toThrow(/base fee/);
  });

  it("refuses graduated tokens when no fallback is configured", async () => {
    const a = adapter({ graduated: true, rate: 1000n, calls: [] });
    expect((await a.detect(target)).live).toBe(false);
    await expect(a.prepare(target, wallet!, {})).rejects.toThrow(/graduated/);
  });

  it("routes graduated tokens through the Uniswap V2 fallback when configured", async () => {
    const a = adapter({ graduated: true, rate: 1000n, calls: [] }, { graduatedFallback: { routerAddress: ROUTER } });
    const s = await a.detect(target);
    expect(s.live).toBe(true);
    expect(s.detectedStyle).toBe("uniswap-v2-router (graduated)");
    const tx = await a.prepare(target, wallet!, {});
    const parsed = parseTransaction(toHex(tx.unsigned));
    expect(parsed.to?.toLowerCase()).toBe(ROUTER);
    const { functionName, args } = decodeFunctionData({ abi: UNISWAP_V2_ROUTER.abi, data: parsed.data! });
    expect(functionName).toBe("swapExactETHForTokens");
    expect(args![0]).toBe((2000n * 10n ** 18n * 9500n) / 10000n);
    expect((args![1] as string[]).map((x) => x.toLowerCase())).toEqual([WETH, TOKEN]);
    expect((args![2] as string).toLowerCase()).toBe(wallet!.address.toLowerCase());
    expect(args![3]).toBe(BLOCK_TS + 60n);
  });

  it("maps launchpad addresses to registered definitions", async () => {
    const reg = new LaunchpadRegistry();
    expect(() => new EvmTokenAdapter({ chain: "base", rpcUrl: "x", registry: reg, launchpads: { [LAUNCHPAD]: "nope" } })).toThrow(/unknown/);
    const state = { graduated: false, rate: 10n, calls: [] as string[] };
    const a = adapter(state, { launchpads: { [ROUTER.toUpperCase().replace("0X", "0x")]: "uniswap-v2-router" } });
    const tx = await a.prepare({ ...target, launchpadAddress: ROUTER }, wallet!, {});
    expect(decodeFunctionData({ abi: UNISWAP_V2_ROUTER.abi, data: parseTransaction(toHex(tx.unsigned)).data! }).functionName)
      .toBe("swapExactETHForTokens");
  });

  it("rejects bad slippage and zero spend", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    await expect(a.prepare({ ...target, slippageBps: 10_000 }, wallet!, {})).rejects.toThrow(/slippageBps/);
    await expect(a.prepare({ ...target, spendPerWallet: "0" }, wallet!, {})).rejects.toThrow(/spendPerWallet/);
    await expect(a.detect({ ...target, spendPerWallet: "0.01" })).rejects.toThrow(/wei/);
  });

  it("validates constructor options", () => {
    expect(() => adapter({ graduated: false, rate: 1n, calls: [] }, { gasMultiplierBps: 1.15 })).toThrow(/gasMultiplierBps/);
    expect(() => adapter({ graduated: false, rate: 1n, calls: [] }, { graduatedFallback: { routerAddress: "0xbad" } })).toThrow(/routerAddress/);
  });

  it("simulates a copied PreparedTx with the original sender", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    const tx = await a.prepare(target, wallet!, {});
    const copy = { ...tx, unsigned: new Uint8Array(tx.unsigned) };
    expect((await a.simulate(copy)).ok).toBe(true);
  });

  it("simulate decodes custom-error reverts", async () => {
    const state: FakeChain = { graduated: false, rate: 1000n, calls: [] };
    const a = adapter(state);
    const tx = await a.prepare(target, wallet!, {});
    expect((await a.simulate(tx)).ok).toBe(true);
    state.revertCalls = encodeErrorResult({ abi: GENERIC_BONDING_CURVE.abi, errorName: "SlippageExceeded", args: [1n, 2n] });
    const sim = await a.simulate(tx);
    expect(sim.ok).toBe(false);
    expect(sim.error).toBe("reverted: SlippageExceeded(1, 2)");
    await expect(a.prepare(target, wallet!, {})).rejects.toThrow(/SlippageExceeded/);
  });

  it("simulate reports unparseable txs", async () => {
    const a = adapter({ graduated: false, rate: 1000n, calls: [] });
    const r = await a.simulate({ chain: "base", walletId: "w", unsigned: hexToBytes("0x1234"), value: "0", description: "" });
    expect(r.ok).toBe(false);
  });
});
