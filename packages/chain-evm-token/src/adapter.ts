// EVM token-launch ChainAdapter (ethereum | base | robinhood) built on viem.

import {
  BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, encodeFunctionData, getAddress, hexToBytes,
  http, isAddress, parseTransaction, recoverTransactionAddress, serializeTransaction, toHex,
  type Abi, type Address, type Hex, type PublicClient, type TransactionSerializedEIP1559,
} from "viem";
import type {
  ChainAdapter, ChainId, FeeStrategy, MintState, MintTarget, PreparedTx, SimulationResult,
  TokenLaunchTarget, WalletRef,
} from "@mint-engine/core";
import {
  ERC20_ABI, GENERIC_BONDING_CURVE, LaunchpadRegistry,
  type LaunchpadCallContext, type LaunchpadDefinition, type LaunchpadPhase,
} from "./launchpads.js";

export type EvmChain = Extract<ChainId, "ethereum" | "base" | "robinhood">;
export const EVM_TOKEN_CHAINS: readonly EvmChain[] = ["ethereum", "base", "robinhood"];

/** Rough block times, used only to turn the 60 s deadline into a `validUntil` block hint. */
const DEFAULT_BLOCK_TIME_SEC: Record<EvmChain, number> = { ethereum: 12, base: 2, robinhood: 1 };

export interface EvmTokenAdapterOptions {
  chain: EvmChain;
  rpcUrl: string;
  /** Numeric chain id. When omitted it is read once from the RPC (`eth_chainId`). */
  evmChainId?: number;
  /** Inject a pre-built client (tests / shared transports). Overrides `rpcUrl`. */
  client?: PublicClient;
  registry?: LaunchpadRegistry;
  /** Launchpad contract address (any case) → definition id. Unlisted addresses use `defaultDefinition`. */
  launchpads?: Record<string, string>;
  /** Definition used for unlisted launchpad addresses. Default "generic-bonding-curve". */
  defaultDefinition?: string;
  /**
   * When a launchpad reports the token as graduated, buy through this router instead.
   * When unset, graduated tokens are refused (detect → live:false, prepare throws).
   */
  graduatedFallback?: { routerAddress: string; definition?: string };
  /** Gas limit = estimate × gasMultiplierBps / 10_000. Integer ≥ 10_000. Default 11_500 (×1.15). */
  gasMultiplierBps?: number;
  blockTimeSec?: number;
}

interface Resolved {
  def: LaunchpadDefinition;
  /** Contract the buy goes to (launchpad, or fallback router). */
  address: Address;
  ctx: LaunchpadCallContext;
  live: boolean;
  /** The configured launchpad reported the token as graduated. */
  graduated: boolean;
  usingFallback: boolean;
}

const BPS = 10_000n;

export class EvmTokenAdapter implements ChainAdapter {
  readonly chain: EvmChain;
  readonly kind = "token" as const;
  readonly client: PublicClient;
  readonly registry: LaunchpadRegistry;

  private readonly opts: EvmTokenAdapterOptions;
  private readonly launchpadMap = new Map<string, string>();
  private readonly extrasCache = new Map<string, Promise<Record<string, unknown>>>();
  private readonly decimalsCache = new Map<string, Promise<number>>();
  private chainIdPromise?: Promise<number>;
  /**
   * Sender of each tx we prepared, keyed by the unsigned tx hex (survives copies of PreparedTx),
   * so `simulate` can eth_call with the right `from`. Bounded FIFO.
   */
  private readonly senders = new Map<string, Address>();
  private static readonly MAX_SENDERS = 4096;

  constructor(opts: EvmTokenAdapterOptions) {
    if (!EVM_TOKEN_CHAINS.includes(opts.chain)) throw new Error(`EvmTokenAdapter: unsupported chain ${opts.chain}`);
    this.opts = opts;
    this.chain = opts.chain;
    this.client = opts.client ?? createPublicClient({ transport: http(opts.rpcUrl) });
    this.registry = opts.registry ?? new LaunchpadRegistry();
    for (const [addr, id] of Object.entries(opts.launchpads ?? {})) {
      this.registry.get(id); // fail fast on unknown ids
      this.launchpadMap.set(addr.toLowerCase(), id);
    }
    this.registry.get(opts.defaultDefinition ?? GENERIC_BONDING_CURVE.id);
    if (opts.graduatedFallback) {
      this.registry.get(opts.graduatedFallback.definition ?? "uniswap-v2-router");
      if (!isAddress(opts.graduatedFallback.routerAddress)) {
        throw new Error(`graduatedFallback.routerAddress is not a valid address: ${opts.graduatedFallback.routerAddress}`);
      }
    }
    const mult = opts.gasMultiplierBps;
    if (mult !== undefined && (!Number.isInteger(mult) || mult < 10_000)) {
      throw new Error(`gasMultiplierBps must be an integer >= 10000, got ${mult}`);
    }
  }

  supports(target: MintTarget): boolean {
    return target.kind === "token" && target.chain === this.chain
      && isAddress(target.tokenAddress) && isAddress(target.launchpadAddress);
  }

  async detect(target: MintTarget): Promise<MintState> {
    const t = this.asToken(target);
    const given = parseWei(t.spendPerWallet);
    const spend = given > 0n ? given : 10n ** 15n;
    const r = await this.resolve(t, spend, getAddress(t.tokenAddress));
    const style = r.usingFallback ? `${r.def.id} (graduated)` : r.graduated ? `${r.def.id}:graduated` : r.def.id;
    if (!r.live) return { live: false, detectedStyle: style };
    const out = await this.quote(r);
    if (out === 0n) return { live: false, detectedStyle: style };
    const decimals = await this.decimals(r.ctx.token);
    // Price per whole token (10^decimals base units), in wei, derived from the quote.
    return { live: true, pricePerUnit: ((spend * 10n ** BigInt(decimals)) / out).toString(), detectedStyle: style };
  }

  /**
   * Build one unsigned EIP-1559 buy tx. `nonce` is a 0 placeholder: the TxRouter assigns the real
   * per-wallet nonce right before signing, so prepared txs for many wallets can be built in parallel.
   * minTokensOut and the deadline (latest block timestamp + 60 s) are baked into the calldata, so a
   * retry after `validUntil` must call prepare again rather than re-send the same PreparedTx.
   * `fees.maxTotalFee` caps gas × maxFeePerGas (L2 execution); OP-stack L1 data fees come on top.
   */
  async prepare(target: MintTarget, wallet: WalletRef, fees: FeeStrategy): Promise<PreparedTx> {
    const t = this.asToken(target);
    if (wallet.family !== "evm" || !isAddress(wallet.address)) throw new Error(`wallet ${wallet.id} is not an EVM wallet`);
    const from = getAddress(wallet.address);
    const spend = parseWei(t.spendPerWallet);
    if (spend <= 0n) throw new Error("spendPerWallet must be > 0");
    if (!Number.isInteger(t.slippageBps) || t.slippageBps < 0 || t.slippageBps >= 10_000) {
      throw new Error(`slippageBps must be an integer in [0, 10000), got ${t.slippageBps}`);
    }

    const [r, block, chainId, estPriority] = await Promise.all([
      this.resolve(t, spend, from),
      this.client.getBlock({ blockTag: "latest" }),
      this.chainId(),
      fees.priorityFee !== undefined
        ? Promise.resolve(BigInt(fees.priorityFee))
        : this.client.estimateMaxPriorityFeePerGas().catch(() => 1_000_000_000n),
    ]);
    if (!r.live) {
      throw new Error(r.graduated
        ? `token ${t.tokenAddress} has graduated from launchpad ${t.launchpadAddress}; refusing to buy (no graduated fallback configured)`
        : `token ${t.tokenAddress} is not live on ${r.def.id}`);
    }
    const quoted = await this.quote(r);
    if (quoted === 0n) throw new Error(`quote for ${t.tokenAddress} returned 0 tokens`);
    const minTokensOut = (quoted * (BPS - BigInt(t.slippageBps))) / BPS;
    const deadline = r.def.deadlineSeconds !== undefined ? block.timestamp + BigInt(r.def.deadlineSeconds) : 0n;
    const data = encodeFunctionData({
      abi: r.def.abi,
      functionName: r.def.buy.functionName,
      args: r.def.buy.args({ ...r.ctx, minTokensOut, deadline }),
    } as Parameters<typeof encodeFunctionData>[0]);

    let estimate: bigint;
    try {
      estimate = await this.client.estimateGas({ account: from, to: r.address, data, value: spend });
    } catch (err) {
      throw new Error(`gas estimation failed: ${this.describeRevert(err)}`);
    }
    const gas = (estimate * BigInt(this.opts.gasMultiplierBps ?? 11_500)) / BPS;

    const baseFee = block.baseFeePerGas ?? 0n;
    let priority = estPriority;
    let maxFee = fees.maxFee !== undefined ? BigInt(fees.maxFee) : baseFee * 2n + priority;
    if (fees.maxTotalFee !== undefined) {
      const cap = BigInt(fees.maxTotalFee) / gas;
      if (cap < maxFee) maxFee = cap;
    }
    if (maxFee < baseFee) {
      throw new Error(`fee cap ${maxFee} wei/gas is below the current base fee ${baseFee}`);
    }
    if (priority > maxFee) priority = maxFee;

    const serialized = serializeTransaction({
      type: "eip1559", chainId, nonce: 0, to: r.address, value: spend, data, gas,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: priority,
    });

    const blockTime = this.opts.blockTimeSec ?? DEFAULT_BLOCK_TIME_SEC[this.chain];
    const prepared: PreparedTx = {
      chain: this.chain,
      walletId: wallet.id,
      unsigned: hexToBytes(serialized),
      value: spend.toString(),
      computeOrGas: Number(gas),
      validUntil: deadline > 0n
        ? Number(block.number) + Math.ceil(Number(deadline - block.timestamp) / blockTime)
        : undefined,
      description: `${wallet.label}: buy ${t.tokenAddress} via ${r.def.id} for ${spend} wei, min ${minTokensOut} out (quote ${quoted}, slippage ${t.slippageBps} bps)`,
    };
    this.rememberSender(serialized, from);
    return prepared;
  }

  /** eth_call the tx (signed if given, else the unsigned one) at the latest block; reverts are decoded. */
  async simulate(tx: PreparedTx, signedTx?: Uint8Array): Promise<SimulationResult> {
    let parsed: ReturnType<typeof parseTransaction>;
    let from: Address | undefined = this.senders.get(toHex(tx.unsigned));
    try {
      if (signedTx) {
        const hex = toHex(signedTx) as TransactionSerializedEIP1559;
        parsed = parseTransaction(hex);
        from = await recoverTransactionAddress({ serializedTransaction: hex });
      } else {
        parsed = parseTransaction(toHex(tx.unsigned));
      }
    } catch (err) {
      return { ok: false, error: `could not parse tx: ${(err as Error).message}` };
    }
    if (!parsed.to) return { ok: false, error: "tx has no recipient" };
    const call = { account: from, to: parsed.to, data: parsed.data, value: parsed.value ?? 0n, gas: parsed.gas };
    // eth_call is the verdict; estimateGas runs alongside only to report gas.
    const [callRes, gasRes] = await Promise.allSettled([this.client.call(call), this.client.estimateGas(call)]);
    if (callRes.status === "rejected") return { ok: false, error: this.describeRevert(callRes.reason) };
    return { ok: true, computeOrGasUsed: gasRes.status === "fulfilled" ? Number(gasRes.value) : undefined };
  }

  // ---------- internals ----------

  private rememberSender(unsignedHex: string, from: Address): void {
    this.senders.delete(unsignedHex);
    this.senders.set(unsignedHex, from);
    while (this.senders.size > EvmTokenAdapter.MAX_SENDERS) {
      const oldest = this.senders.keys().next().value;
      if (oldest === undefined) break;
      this.senders.delete(oldest);
    }
  }

  private asToken(target: MintTarget): TokenLaunchTarget {
    if (!this.supports(target)) throw new Error(`EvmTokenAdapter(${this.chain}) does not support this target`);
    return target as TokenLaunchTarget;
  }

  private chainId(): Promise<number> {
    if (this.opts.evmChainId !== undefined) return Promise.resolve(this.opts.evmChainId);
    if (!this.chainIdPromise) {
      this.chainIdPromise = this.client.getChainId().catch((e: unknown) => {
        this.chainIdPromise = undefined;
        throw e;
      });
    }
    return this.chainIdPromise;
  }

  private definitionFor(launchpad: string): LaunchpadDefinition {
    const id = this.launchpadMap.get(launchpad.toLowerCase()) ?? this.opts.defaultDefinition ?? GENERIC_BONDING_CURVE.id;
    return this.registry.get(id);
  }

  private extras(def: LaunchpadDefinition, address: Address): Promise<Record<string, unknown>> {
    if (!def.loadExtras) return Promise.resolve({});
    const key = `${def.id}:${address.toLowerCase()}`;
    const cached = this.extrasCache.get(key);
    if (cached) return cached;
    const p = def.loadExtras(this.client, address).catch((e: unknown) => {
      this.extrasCache.delete(key);
      throw e;
    });
    this.extrasCache.set(key, p);
    return p;
  }

  private decimals(token: Address): Promise<number> {
    const cached = this.decimalsCache.get(token);
    if (cached) return cached;
    const p = this.client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })
      .then(Number)
      .catch((e: unknown) => {
        this.decimalsCache.delete(token);
        throw e;
      });
    this.decimalsCache.set(token, p);
    return p;
  }

  private async resolve(t: TokenLaunchTarget, spend: bigint, recipient: Address): Promise<Resolved> {
    const token = getAddress(t.tokenAddress);
    const launchpad = getAddress(t.launchpadAddress);
    const def = this.definitionFor(launchpad);
    const ctx: LaunchpadCallContext = { token, launchpad, spend, recipient, extras: await this.extras(def, launchpad) };
    const phase = await this.readPhase(def, launchpad, ctx);
    if (phase !== "graduated") return { def, address: launchpad, ctx, live: phase === "live", graduated: false, usingFallback: false };

    // The launchpad says the token has graduated.
    const fb = this.opts.graduatedFallback;
    if (!fb) return { def, address: launchpad, ctx, live: false, graduated: true, usingFallback: false };
    const fbDef = this.registry.get(fb.definition ?? "uniswap-v2-router");
    const router = getAddress(fb.routerAddress);
    const fbCtx: LaunchpadCallContext = { ...ctx, launchpad: router, extras: await this.extras(fbDef, router) };
    const fbPhase = await this.readPhase(fbDef, router, fbCtx);
    return { def: fbDef, address: router, ctx: fbCtx, live: fbPhase === "live", graduated: true, usingFallback: true };
  }

  private async readPhase(def: LaunchpadDefinition, address: Address, ctx: LaunchpadCallContext): Promise<LaunchpadPhase> {
    if (!def.state) return "live"; // decided by the quote
    const res = await this.client.readContract({
      address, abi: def.abi, functionName: def.state.functionName, args: def.state.args(ctx),
    } as Parameters<PublicClient["readContract"]>[0]);
    return def.state.parse(res);
  }

  private async quote(r: Resolved): Promise<bigint> {
    try {
      const res = await this.client.readContract({
        address: r.address, abi: r.def.abi, functionName: r.def.quote.functionName, args: r.def.quote.args(r.ctx),
      } as Parameters<PublicClient["readContract"]>[0]);
      return r.def.quote.parse(res);
    } catch (err) {
      // A revert on a router-style definition (no pool / no liquidity) means "nothing to buy".
      // Transport errors (timeouts, rate limits) are rethrown.
      if (!r.def.state && isRevert(err)) return 0n;
      throw err;
    }
  }

  /** Turn a viem call/estimate error into a readable reason, decoding custom errors from all registered ABIs. */
  describeRevert(err: unknown): string {
    const data = findRevertData(err);
    if (data && data !== "0x") {
      const abi = this.registry.all().flatMap((d) => d.abi.filter((i) => i.type === "error")) as Abi;
      try {
        const decoded = decodeErrorResult({ abi, data });
        const args = (decoded.args ?? []).map((a) => String(a)).join(", ");
        return `reverted: ${decoded.errorName}(${args})`;
      } catch {
        return `reverted with unknown error data ${data}`;
      }
    }
    if (err instanceof BaseError) return err.shortMessage;
    return err instanceof Error ? err.message : String(err);
  }
}

function parseWei(v: string): bigint {
  if (!/^\d+$/.test(v)) throw new Error(`spendPerWallet must be an integer amount in wei (decimal string), got "${v}"`);
  return BigInt(v);
}

function isRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}

function findRevertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  let found: Hex | undefined;
  err.walk((e) => {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x")) { found = d as Hex; return true; }
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      found = (d as { data: Hex }).data;
      return true;
    }
    return false;
  });
  return found;
}
