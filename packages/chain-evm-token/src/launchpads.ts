// Launchpad definitions: how to talk to a particular token-launch contract.
//
// The adapter never hard-codes a launchpad ABI. Instead every supported launchpad is described
// by a `LaunchpadDefinition` (buy function + arg builder, view quote, live/graduated reader and
// an optional deadline). New launchpads are added by registering another definition.

import { parseAbi, type Abi, type Address, type PublicClient } from "viem";

/** Inputs every arg builder receives. All amounts are base units. */
export interface LaunchpadCallContext {
  token: Address;
  launchpad: Address;
  /** Native currency (wei) the wallet spends. */
  spend: bigint;
  /** Wallet that receives the tokens. */
  recipient: Address;
  /** Extra values the definition loaded once per launchpad via `loadExtras` (e.g. WETH address). */
  extras: Record<string, unknown>;
}

export interface BuyCallContext extends LaunchpadCallContext {
  minTokensOut: bigint;
  /** Unix seconds; 0n when the definition has no deadline. */
  deadline: bigint;
}

export type LaunchpadPhase = "live" | "not-live" | "graduated";

export interface LaunchpadDefinition {
  /** Stable id used in the registry and reported as `MintState.detectedStyle`. */
  id: string;
  description: string;
  /** ABI containing (at least) the buy, quote and state functions plus any custom errors. */
  abi: Abi;
  /** Optional one-off reads per launchpad (cached by the adapter). */
  loadExtras?: (client: PublicClient, launchpad: Address) => Promise<Record<string, unknown>>;
  /** Payable buy function. `value` is always `spendPerWallet`. */
  buy: { functionName: string; args: (ctx: BuyCallContext) => readonly unknown[] };
  /** View function returning the expected tokens out for `spend`. */
  quote: {
    functionName: string;
    args: (ctx: LaunchpadCallContext) => readonly unknown[];
    /** Map the raw return value to the tokens-out amount. */
    parse: (result: unknown) => bigint;
  };
  /** Optional live/graduated reader. When absent the launchpad is treated as live while the quote is > 0. */
  state?: {
    functionName: string;
    args: (ctx: LaunchpadCallContext) => readonly unknown[];
    /**
     * Map the raw return value to the curve phase. Only "graduated" triggers the adapter's
     * graduated fallback router; "not-live" (not started / paused) just reports live:false.
     */
    parse: (result: unknown) => LaunchpadPhase;
  };
  /** Seconds added to the latest block timestamp for the deadline arg; omit when the buy has no deadline. */
  deadlineSeconds?: number;
}

/** Shared ERC20 reads. */
export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

/**
 * Generic bonding-curve launchpad:
 *   buy(address token, uint256 minTokensOut, uint256 deadline) payable
 *   getBuyQuote(address token, uint256 ethIn) view returns (uint256)
 *   isGraduated(address token) view returns (bool)
 */
export const GENERIC_BONDING_CURVE: LaunchpadDefinition = {
  id: "generic-bonding-curve",
  description: "Generic bonding curve: buy(token, minTokensOut, deadline) payable",
  abi: parseAbi([
    "function buy(address token, uint256 minTokensOut, uint256 deadline) payable",
    "function getBuyQuote(address token, uint256 ethIn) view returns (uint256)",
    "function isGraduated(address token) view returns (bool)",
    "error SlippageExceeded(uint256 tokensOut, uint256 minTokensOut)",
    "error DeadlineExpired(uint256 deadline, uint256 timestamp)",
    "error AlreadyGraduated(address token)",
    "error UnknownToken(address token)",
  ]),
  buy: {
    functionName: "buy",
    args: ({ token, minTokensOut, deadline }) => [token, minTokensOut, deadline],
  },
  quote: {
    functionName: "getBuyQuote",
    args: ({ token, spend }) => [token, spend],
    parse: (r) => r as bigint,
  },
  state: {
    functionName: "isGraduated",
    args: ({ token }) => [token],
    parse: (graduated) => (graduated === false ? "live" : "graduated"),
  },
  deadlineSeconds: 60,
};

/**
 * Uniswap V2 router fallback for tokens that already graduated to an AMM pool:
 *   swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable
 *   getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])
 * `launchpadAddress` (or the configured fallback) is the router address.
 */
export const UNISWAP_V2_ROUTER: LaunchpadDefinition = {
  id: "uniswap-v2-router",
  description: "Uniswap V2 router: swapExactETHForTokens(minOut, [WETH, token], to, deadline)",
  abi: parseAbi([
    "function WETH() view returns (address)",
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  ]),
  loadExtras: async (client, router) => ({
    weth: await client.readContract({ address: router, abi: UNISWAP_V2_ROUTER.abi, functionName: "WETH" }),
  }),
  buy: {
    functionName: "swapExactETHForTokens",
    args: ({ token, minTokensOut, recipient, deadline, extras }) =>
      [minTokensOut, [wethOf(extras), token], recipient, deadline],
  },
  quote: {
    functionName: "getAmountsOut",
    args: ({ token, spend, extras }) => [spend, [wethOf(extras), token]],
    parse: (r) => {
      const amounts = r as readonly bigint[];
      return amounts[amounts.length - 1] ?? 0n;
    },
  },
  deadlineSeconds: 60,
};

function wethOf(extras: Record<string, unknown>): Address {
  const weth = extras["weth"];
  if (typeof weth !== "string") throw new Error("uniswap-v2-router: WETH address not loaded");
  return weth as Address;
}

/** Registry of launchpad definitions by id. */
export class LaunchpadRegistry {
  private readonly defs = new Map<string, LaunchpadDefinition>();

  constructor(defs: LaunchpadDefinition[] = [GENERIC_BONDING_CURVE, UNISWAP_V2_ROUTER]) {
    for (const d of defs) this.register(d);
  }

  register(def: LaunchpadDefinition): this {
    this.defs.set(def.id, def);
    return this;
  }

  get(id: string): LaunchpadDefinition {
    const def = this.defs.get(id);
    if (!def) throw new Error(`unknown launchpad definition "${id}"`);
    return def;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  all(): LaunchpadDefinition[] {
    return [...this.defs.values()];
  }
}
