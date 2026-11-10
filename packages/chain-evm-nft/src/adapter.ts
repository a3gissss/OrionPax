import {
  bytesToHex, createPublicClient, encodeAbiParameters, encodeFunctionData, fallback, formatEther, getAddress, hexToBytes, http,
  isAddress, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type AbiFunction, type Address, type Hex, type PublicClient, type TransactionSerializedEIP1559,
} from "viem";
import {
  CHAIN_FAMILY,
  type ChainAdapter, type ChainConfig, type ChainId, type FeeStrategy, type MintKind, type MintState, type MintTarget,
  type NftMintTarget, type PreparedTx, type SimulationResult, type WalletRef,
} from "@mint-engine/core";
import {
  MAX_PER_WALLET_GETTERS, MAX_SUPPLY_GETTERS, OPENSEA_FEE_RECIPIENT, PRICE_GETTERS, SALE_ACTIVE_GETTERS, SEADROP_ADDRESS,
  ZORA_FIXED_PRICE_STRATEGY, addrUintGetterAbi, boolGetterAbi, erc721aMintAbi, seaDropAbi, seaDropTokenAbi, uintGetterAbi,
  zora1155Abi, zoraStrategyAbi,
} from "./abis.js";
import {
  coerceArgs, eip1167Target, hasSelector, parseCustomFunction, revertReason, safeNum, slotToAddress,
} from "./util.js";

export type EvmChainId = Extract<ChainId, "ethereum" | "base" | "robinhood">;
export type EvmNftStyle = "seadrop" | "zora-1155" | "erc721a" | "custom";

export interface EvmNftAdapterOptions {
  /** Inject a viem public client (tests). Defaults to an HTTP client over `rpcUrl` (+ `extraRpcUrls` as fallbacks). */
  client?: PublicClient;
  /** SeaDrop contract. Default: canonical OpenSea deployment. */
  seaDropAddress?: string;
  /** Fee recipient passed to `mintPublic` when the drop does not restrict fee recipients. */
  seaDropFeeRecipient?: string;
  /** Zora fixed-price sale strategy (minter). Default: canonical Zora deployment. */
  zoraFixedPriceStrategy?: string;
  /** Zora mint referral / rewards recipient. Optional. */
  zoraMintReferral?: string;
  /**
   * Nonce source. When omitted, `prepare` emits `nonce: 0` as a placeholder and the router/engine is
   * expected to assign the real nonce (see `withNonce`) before signing.
   */
  nonceProvider?: (wallet: WalletRef, chain: ChainId) => Promise<number> | number;
  /** Gas limit = estimate × gasMultiplierBps / 10000. Default 11500 (×1.15). */
  gasMultiplierBps?: number;
  /** Gas limit used when the mint is not live yet and estimation reverts. Default 300000. */
  fallbackGasLimit?: bigint;
  /** How long a mint-state snapshot is reused across `prepare` calls. Default 1000 ms. */
  stateTtlMs?: number;
}

/** Thrown when a requested quantity would break the on-chain per-wallet limit or remaining supply. */
export class MintLimitError extends Error {
  override name = "MintLimitError";
}

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
/** Address used for state-override eth_call probes when no wallet is involved (local-only, never signs). */
const PROBE_ACCOUNT = "0x00000000000000000000000000000000000fa1ce" as const; // all-lowercase: valid without checksum

type Getters = { price?: string; maxPerWallet?: string; saleActive?: string; paused?: boolean; maxSupply?: string; minted?: string };

interface Plan {
  style: EvmNftStyle;
  address: Address;
  tokenId: bigint;
  /** erc721a */
  mintFn?: "mint" | "publicMint";
  /** zora-1155 */
  zoraVariant?: "rewardsRecipients" | "mintWithRewards" | "legacy";
  /** custom */
  customFn?: AbiFunction;
  /** erc721a / custom getters that answered */
  getters: Getters;
}

interface Snapshot {
  state: MintState;
  pricePerUnit: bigint;
  feeRecipient?: Address;
  at: number;
}

export class EvmNftAdapter implements ChainAdapter {
  readonly chain: EvmChainId;
  readonly kind: MintKind = "nft";
  private readonly client: PublicClient;
  private readonly seaDrop: Address;
  private readonly zoraStrategy: Address;
  private readonly gasBps: bigint;
  private readonly fallbackGas: bigint;
  private readonly ttl: number;
  private readonly plans = new Map<string, Promise<Plan>>();
  private readonly snapshots = new Map<string, Promise<Snapshot>>();
  private readonly walletAddresses = new Map<string, Address>();
  private chainIdP?: Promise<number>;

  constructor(readonly config: ChainConfig, private readonly opts: EvmNftAdapterOptions = {}) {
    if (CHAIN_FAMILY[config.chain] !== "evm") throw new Error(`EvmNftAdapter: ${config.chain} is not an EVM chain`);
    this.chain = config.chain as EvmChainId;
    const urls = [config.rpcUrl, ...(config.extraRpcUrls ?? [])];
    this.client = opts.client ?? createPublicClient({
      transport: urls.length > 1 ? fallback(urls.map((u) => http(u, { batch: true }))) : http(config.rpcUrl, { batch: true }),
    });
    this.seaDrop = getAddress(opts.seaDropAddress ?? SEADROP_ADDRESS);
    this.zoraStrategy = getAddress(opts.zoraFixedPriceStrategy ?? ZORA_FIXED_PRICE_STRATEGY);
    this.gasBps = BigInt(opts.gasMultiplierBps ?? 11_500);
    this.fallbackGas = opts.fallbackGasLimit ?? 300_000n;
    this.ttl = opts.stateTtlMs ?? 1_000;
  }

  supports(target: MintTarget): boolean {
    return target.kind === "nft" && target.chain === this.chain && target.style !== "core-candy-machine"
      && isAddress(target.address);
  }

  async detect(target: MintTarget): Promise<MintState> {
    const t = this.assertTarget(target);
    const plan = await this.plan(t);
    const snap = await this.snapshot(t, plan, true);
    return { ...snap.state };
  }

  async prepare(target: MintTarget, wallet: WalletRef, fees: FeeStrategy): Promise<PreparedTx> {
    const t = this.assertTarget(target);
    if (wallet.family !== "evm" || !isAddress(wallet.address)) throw new Error(`wallet ${wallet.id} is not an EVM wallet`);
    const qty = t.quantity;
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error(`invalid quantity ${qty}`);
    const from = getAddress(wallet.address);
    this.walletAddresses.set(wallet.id, from);

    const plan = await this.plan(t);
    const [snap, minted] = await Promise.all([this.snapshot(t, plan), this.mintedBy(plan, from)]);
    const { state } = snap;

    if (state.maxPerWallet !== undefined) {
      const allowed = Math.max(0, state.maxPerWallet - (minted ?? 0));
      if (qty > allowed) {
        throw new MintLimitError(
          `quantity ${qty} exceeds per-wallet limit for ${wallet.label}: max ${state.maxPerWallet}, already minted ${minted ?? 0}`,
        );
      }
    }
    if (state.remainingSupply !== undefined && qty > state.remainingSupply) {
      throw new MintLimitError(`quantity ${qty} exceeds remaining supply ${state.remainingSupply}`);
    }

    const call = this.buildCall(plan, snap, t, from);
    const value = snap.pricePerUnit * BigInt(qty);

    const [gasEst, block, tip, nonce, chainId] = await Promise.all([
      this.client.estimateGas({ account: from, to: call.to, data: call.data, value }).then(
        (g) => ({ ok: true as const, g }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
      this.client.getBlock({ blockTag: "latest" }),
      fees.priorityFee !== undefined ? Promise.resolve(BigInt(fees.priorityFee)) : this.client.estimateMaxPriorityFeePerGas(),
      this.opts.nonceProvider ? Promise.resolve(this.opts.nonceProvider(wallet, this.chain)) : Promise.resolve(0),
      this.chainId(),
    ]);

    let gas: bigint;
    if (gasEst.ok) gas = (gasEst.g * this.gasBps + 9_999n) / 10_000n;
    else if (!state.live) gas = this.fallbackGas;
    else throw new Error(`mint would revert for ${wallet.label}: ${revertReason(gasEst.e)}`);

    const baseFee = block.baseFeePerGas ?? 0n;
    let maxPriorityFeePerGas = tip;
    let maxFeePerGas = fees.maxFee !== undefined ? BigInt(fees.maxFee) : baseFee * 2n + maxPriorityFeePerGas;
    if (fees.maxTotalFee !== undefined) {
      const cap = BigInt(fees.maxTotalFee) / gas;
      if (cap < maxFeePerGas) maxFeePerGas = cap;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
    if (maxFeePerGas < baseFee) {
      throw new Error(`fee cap ${maxFeePerGas} wei/gas is below current base fee ${baseFee}; raise maxFee/maxTotalFee`);
    }

    const serialized = serializeTransaction({
      type: "eip1559", chainId, nonce, to: call.to, data: call.data, value, gas, maxFeePerGas, maxPriorityFeePerGas,
    });

    return {
      chain: this.chain,
      walletId: wallet.id,
      unsigned: hexToBytes(serialized),
      value: value.toString(),
      computeOrGas: Number(gas),
      description: `${plan.style} mint x${qty} on ${this.chain} @ ${plan.address}`
        + (plan.style === "zora-1155" ? ` token ${plan.tokenId}` : "")
        + ` for ${wallet.label}: ${formatEther(value)} ETH`
        + ((plan.style === "erc721a" || plan.style === "custom") && !plan.getters.price ? " (no price getter found; value assumed 0)" : ""),
    };
  }

  async simulate(tx: PreparedTx, signedTx?: Uint8Array): Promise<SimulationResult> {
    try {
      const hex = bytesToHex(signedTx ?? tx.unsigned);
      const parsed = parseTransaction(hex);
      const from = signedTx
        ? await recoverTransactionAddress({ serializedTransaction: hex as TransactionSerializedEIP1559 })
        : this.walletAddresses.get(tx.walletId);
      if (!from) return { ok: false, error: `unknown wallet ${tx.walletId}: prepare it with this adapter or pass signedTx` };
      if (!parsed.to) return { ok: false, error: "transaction has no recipient" };
      const req = { account: from, to: parsed.to, data: parsed.data, value: parsed.value ?? 0n };
      // eth_call is the source of truth (decoded revert); the gas estimate runs alongside for computeOrGasUsed.
      const [res, gasUsed] = await Promise.all([
        this.client.call({ ...req, gas: parsed.gas }).then(() => undefined, (e: unknown) => revertReason(e)),
        this.client.estimateGas(req).catch(() => undefined),
      ]);
      if (res !== undefined) return { ok: false, error: res };
      return { ok: true, computeOrGasUsed: gasUsed !== undefined ? Number(gasUsed) : undefined };
    } catch (e) {
      return { ok: false, error: revertReason(e) };
    }
  }

  // ---------- internals ----------

  private assertTarget(target: MintTarget): NftMintTarget {
    if (!this.supports(target)) throw new Error(`EvmNftAdapter(${this.chain}) does not support target`);
    return target as NftMintTarget;
  }

  private chainId(): Promise<number> {
    if (this.config.evmChainId !== undefined) return Promise.resolve(this.config.evmChainId);
    this.chainIdP ??= this.client.getChainId().catch((e: unknown) => { this.chainIdP = undefined; throw e; });
    return this.chainIdP;
  }

  private key(t: NftMintTarget): string {
    return [t.address.toLowerCase(), t.tokenId ?? "", t.style ?? "", t.customFunction?.signature ?? ""].join("|");
  }

  private plan(t: NftMintTarget): Promise<Plan> {
    const k = this.key(t);
    let p = this.plans.get(k);
    if (!p) {
      p = this.resolvePlan(t);
      this.plans.set(k, p);
      p.catch(() => this.plans.delete(k));
    }
    return p;
  }

  private snapshot(t: NftMintTarget, plan: Plan, fresh = false): Promise<Snapshot> {
    const k = this.key(t);
    const cached = this.snapshots.get(k);
    if (cached && !fresh) {
      return cached.then((s) => {
        if (Date.now() - s.at <= this.ttl) return s;
        // Stale: the first caller refreshes, concurrent callers share that refresh.
        const current = this.snapshots.get(k);
        return current && current !== cached ? current : this.snapshot(t, plan, true);
      });
    }
    const p = this.readState(t, plan);
    this.snapshots.set(k, p);
    p.catch(() => { if (this.snapshots.get(k) === p) this.snapshots.delete(k); });
    return p;
  }

  /** Bytecode of the logic contract when `address` is a proxy (EIP-1167 / EIP-1967 / beacon). */
  private async implementationCode(address: Address, code: Hex): Promise<Hex | undefined> {
    const clone = eip1167Target(code);
    if (clone) return this.client.getCode({ address: clone });
    const [implSlot, beaconSlot] = await Promise.all([
      this.client.getStorageAt({ address, slot: EIP1967_IMPL_SLOT }).catch(() => undefined),
      this.client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT }).catch(() => undefined),
    ]);
    const impl = slotToAddress(implSlot);
    if (impl) return this.client.getCode({ address: impl });
    const beacon = slotToAddress(beaconSlot);
    if (beacon) {
      const beaconImpl = await this.client.readContract({
        address: beacon, abi: [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "implementation",
      }).catch(() => undefined);
      if (beaconImpl) return this.client.getCode({ address: beaconImpl });
    }
    return undefined;
  }

  private async resolvePlan(t: NftMintTarget): Promise<Plan> {
    const address = getAddress(t.address);
    const code = await this.client.getCode({ address });
    if (!code || code === "0x") throw new Error(`no contract at ${address} on ${this.chain}`);
    const impl = await this.implementationCode(address, code);
    const has = (sig: string) => hasSelector(code, sig) || hasSelector(impl, sig);
    const tokenId = BigInt(t.tokenId ?? "1");

    let getters: Promise<Getters> | undefined;
    const memoGetters = () => (getters ??= this.resolveGetters(address));

    let style = t.style as EvmNftStyle | undefined;
    if (!style) style = await this.autoDetect(address, tokenId, has, memoGetters);

    const plan: Plan = { style, address, tokenId, getters: {} };
    switch (style) {
      case "seadrop":
        break;
      case "zora-1155":
        plan.zoraVariant = has("mint(address,uint256,uint256,address[],bytes)") ? "rewardsRecipients"
          : has("mintWithRewards(address,uint256,uint256,bytes,address)") ? "mintWithRewards"
          : has("mint(address,uint256,uint256,bytes)") ? "legacy"
          : "mintWithRewards";
        break;
      case "erc721a":
        plan.mintFn = has("publicMint(uint256)") && !has("mint(uint256)") ? "publicMint" : "mint";
        plan.getters = await memoGetters();
        break;
      case "custom":
        if (!t.customFunction) throw new Error(`style "custom" requires customFunction`);
        plan.customFn = parseCustomFunction(t.customFunction.signature);
        plan.getters = await memoGetters();
        break;
      default:
        throw new Error(`unsupported EVM NFT style ${String(style)}`);
    }
    return plan;
  }

  private async autoDetect(
    address: Address, tokenId: bigint, has: (sig: string) => boolean, getters: () => Promise<Getters>,
  ): Promise<EvmNftStyle> {
    const once = (f: () => Promise<boolean>) => { let p: Promise<boolean> | undefined; return () => (p ??= f()); };
    const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
    const isSeaDrop = once(() => ok(this.client.readContract({
      address, abi: seaDropTokenAbi, functionName: "getMintStats", args: [PROBE_ACCOUNT],
    })));
    // Zora: getTokenInfo answers for any id, but an unknown token has maxSupply 0.
    const isZora = once(() => this.client.readContract({
      address, abi: zora1155Abi, functionName: "getTokenInfo", args: [tokenId],
    }).then((info) => info.maxSupply > 0n, () => false));
    const isErc721a = once(async () => {
      const g = await getters();
      return g.price !== undefined || g.saleActive !== undefined || g.maxPerWallet !== undefined;
    });

    const hintSea = has("mintSeaDrop(address,uint256)") || has("getMintStats(address)");
    const hintZora = has("mintWithRewards(address,uint256,uint256,bytes,address)")
      || has("mint(address,uint256,uint256,address[],bytes)")
      || (has("getTokenInfo(uint256)") && has("mintFee()"));
    const hintErc = has("mint(uint256)") || has("publicMint(uint256)");

    if (hintSea && await isSeaDrop()) return "seadrop";
    if (hintZora) {
      if (await isZora()) return "zora-1155";
      throw new Error(`${address} looks like a Zora 1155 but token ${tokenId} is not set up; pass target.tokenId or target.style`);
    }
    if (hintErc) return "erc721a";
    // No dispatcher hints (e.g. unknown proxy pattern): fall back to eth_call probing.
    if (await isSeaDrop()) return "seadrop";
    if (await isZora()) return "zora-1155";
    if (await isErc721a()) return "erc721a";
    throw new Error(`could not detect mint style for ${address} on ${this.chain}; pass target.style explicitly`);
  }

  /** Probe the common ERC721A-style getters in parallel; remember which names answer. */
  private async resolveGetters(address: Address): Promise<Getters> {
    const tryUint = (name: string) => this.client.readContract({ address, abi: uintGetterAbi(name), functionName: name })
      .then(() => name, () => undefined);
    const tryBool = (name: string) => this.client.readContract({ address, abi: boolGetterAbi(name), functionName: name })
      .then(() => name, () => undefined);
    const tryAddrUint = (name: string) => this.client.readContract({
      address, abi: addrUintGetterAbi(name), functionName: name, args: [PROBE_ACCOUNT],
    }).then(() => name, () => undefined);
    const first = async (ps: Array<Promise<string | undefined>>) => (await Promise.all(ps)).find((x) => x !== undefined);

    const [price, maxPerWallet, saleActive, maxSupply, minted, paused] = await Promise.all([
      first(PRICE_GETTERS.map(tryUint)),
      first(MAX_PER_WALLET_GETTERS.map(tryUint)),
      first(SALE_ACTIVE_GETTERS.map(tryBool)),
      first(MAX_SUPPLY_GETTERS.map(tryUint)),
      // Mint counters only; balanceOf counts holdings (transfers), not mints, so it is deliberately not used.
      first(["numberMinted", "mintedPerWallet", "mintCount", "minted", "mintedCount"].map(tryAddrUint)),
      tryBool("paused"),
    ]);
    return { price, maxPerWallet, saleActive, maxSupply, minted, paused: paused !== undefined };
  }

  private async readState(t: NftMintTarget, plan: Plan): Promise<Snapshot> {
    switch (plan.style) {
      case "seadrop": return this.readSeaDrop(plan);
      case "zora-1155": return this.readZora(plan);
      default: return this.readGeneric(t, plan);
    }
  }

  private async now(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "latest" })).timestamp;
  }

  private async readSeaDrop(plan: Plan): Promise<Snapshot> {
    const nft = plan.address;
    const [drop, stats, now] = await Promise.all([
      this.client.readContract({ address: this.seaDrop, abi: seaDropAbi, functionName: "getPublicDrop", args: [nft] }),
      this.client.readContract({ address: nft, abi: seaDropTokenAbi, functionName: "getMintStats", args: [PROBE_ACCOUNT] }),
      this.now(),
    ]);
    const start = BigInt(drop.startTime);
    const end = BigInt(drop.endTime);
    const live = drop.maxTotalMintableByWallet > 0 && start <= now && now <= end && end > 0n;
    let feeRecipient = getAddress(this.opts.seaDropFeeRecipient ?? OPENSEA_FEE_RECIPIENT);
    if (drop.restrictFeeRecipients) {
      const allowed = await this.client.readContract({
        address: this.seaDrop, abi: seaDropAbi, functionName: "getAllowedFeeRecipients", args: [nft],
      });
      const preferred = allowed.find((a) => a.toLowerCase() === feeRecipient.toLowerCase());
      const pick = preferred ?? allowed[0];
      if (!pick) throw new Error(`SeaDrop drop for ${nft} restricts fee recipients but none are allowed`);
      feeRecipient = getAddress(pick);
    }
    const [, totalSupply, maxSupply] = stats;
    return {
      pricePerUnit: drop.mintPrice,
      feeRecipient,
      at: Date.now(),
      state: {
        live,
        startsAt: start > now ? Number(start) * 1000 : undefined,
        pricePerUnit: drop.mintPrice.toString(),
        // An unconfigured drop reads as all zeros: report "unknown" rather than a limit of 0.
        maxPerWallet: end > 0n ? drop.maxTotalMintableByWallet : undefined,
        remainingSupply: maxSupply >= totalSupply ? safeNum(maxSupply - totalSupply) : 0,
        detectedStyle: "seadrop",
      },
    };
  }

  private async readZora(plan: Plan): Promise<Snapshot> {
    const [cfg, fee, info, now] = await Promise.all([
      this.client.readContract({
        address: this.zoraStrategy, abi: zoraStrategyAbi, functionName: "sale", args: [plan.address, plan.tokenId],
      }),
      this.client.readContract({ address: plan.address, abi: zora1155Abi, functionName: "mintFee" }).catch(() => 0n),
      this.client.readContract({
        address: plan.address, abi: zora1155Abi, functionName: "getTokenInfo", args: [plan.tokenId],
      }).catch(() => undefined),
      this.now(),
    ]);
    const live = cfg.saleEnd > 0n && cfg.saleStart <= now && now <= cfg.saleEnd;
    const unit = cfg.pricePerToken + fee;
    return {
      pricePerUnit: unit,
      at: Date.now(),
      state: {
        live,
        startsAt: cfg.saleStart > now ? Number(cfg.saleStart) * 1000 : undefined,
        pricePerUnit: unit.toString(),
        maxPerWallet: cfg.maxTokensPerAddress > 0n ? safeNum(cfg.maxTokensPerAddress) : undefined,
        remainingSupply: info && info.maxSupply > 0n
          ? (info.maxSupply >= info.totalMinted ? safeNum(info.maxSupply - info.totalMinted) : 0)
          : undefined,
        detectedStyle: "zora-1155",
      },
    };
  }

  private async readGeneric(t: NftMintTarget, plan: Plan): Promise<Snapshot> {
    const g = plan.getters;
    const address = plan.address;
    const readUint = (name?: string) => name
      ? this.client.readContract({ address, abi: uintGetterAbi(name), functionName: name }).catch(() => undefined)
      : Promise.resolve(undefined);
    const readBool = (name?: string) => name
      ? this.client.readContract({ address, abi: boolGetterAbi(name), functionName: name }).catch(() => undefined)
      : Promise.resolve(undefined);

    const [price, maxPerWallet, saleActive, paused, maxSupply, totalSupply] = await Promise.all([
      readUint(g.price), readUint(g.maxPerWallet), readBool(g.saleActive), readBool(g.paused ? "paused" : undefined),
      readUint(g.maxSupply), readUint(g.maxSupply ? "totalSupply" : undefined),
    ]);
    const pricePerUnit = price ?? 0n;

    let live: boolean;
    if (saleActive !== undefined) live = saleActive && paused !== true;
    else if (paused !== undefined) live = !paused;
    else {
      // No status getter: dry-run a 1-unit mint from a funded probe account (state override, local eth_call only).
      const probe = this.buildCall(plan, { pricePerUnit, at: 0, state: { live: false } }, { ...t, quantity: 1 }, PROBE_ACCOUNT);
      live = await this.client.call({
        account: PROBE_ACCOUNT, to: probe.to, data: probe.data, value: pricePerUnit,
        stateOverride: [{ address: PROBE_ACCOUNT, balance: 10n ** 30n }],
      }).then(() => true, () => false);
    }

    return {
      pricePerUnit,
      at: Date.now(),
      state: {
        live,
        pricePerUnit: pricePerUnit.toString(),
        maxPerWallet: maxPerWallet !== undefined && maxPerWallet > 0n ? safeNum(maxPerWallet) : undefined,
        remainingSupply: maxSupply !== undefined && totalSupply !== undefined
          ? (maxSupply >= totalSupply ? safeNum(maxSupply - totalSupply) : 0)
          : undefined,
        detectedStyle: plan.style,
      },
    };
  }

  /** Units already minted by `wallet` (counts against the per-wallet limit), when the contract exposes it. */
  private async mintedBy(plan: Plan, wallet: Address): Promise<number | undefined> {
    try {
      switch (plan.style) {
        case "seadrop": {
          const [n] = await this.client.readContract({
            address: plan.address, abi: seaDropTokenAbi, functionName: "getMintStats", args: [wallet],
          });
          return safeNum(n);
        }
        case "zora-1155":
          return safeNum(await this.client.readContract({
            address: this.zoraStrategy, abi: zoraStrategyAbi, functionName: "getMintedPerWallet",
            args: [plan.address, plan.tokenId, wallet],
          }));
        default: {
          const name = plan.getters.minted;
          if (!name) return undefined;
          return safeNum(await this.client.readContract({
            address: plan.address, abi: addrUintGetterAbi(name), functionName: name, args: [wallet],
          }));
        }
      }
    } catch {
      return undefined;
    }
  }

  private buildCall(plan: Plan, snap: Snapshot, t: NftMintTarget, wallet: Address): { to: Address; data: Hex } {
    const qty = BigInt(t.quantity);
    switch (plan.style) {
      case "seadrop":
        return {
          to: this.seaDrop,
          data: encodeFunctionData({
            abi: seaDropAbi, functionName: "mintPublic",
            args: [plan.address, snap.feeRecipient ?? getAddress(OPENSEA_FEE_RECIPIENT), "0x0000000000000000000000000000000000000000", qty],
          }),
        };
      case "zora-1155": {
        const minterArguments = encodeAbiParameters([{ type: "address" }, { type: "string" }], [wallet, ""]);
        const referral = this.opts.zoraMintReferral ? getAddress(this.opts.zoraMintReferral) : undefined;
        let data: Hex;
        if (plan.zoraVariant === "rewardsRecipients") {
          data = encodeFunctionData({
            abi: zora1155Abi, functionName: "mint",
            args: [this.zoraStrategy, plan.tokenId, qty, referral ? [referral] : [], minterArguments],
          });
        } else if (plan.zoraVariant === "legacy") {
          data = encodeFunctionData({
            abi: zora1155Abi, functionName: "mint", args: [this.zoraStrategy, plan.tokenId, qty, minterArguments],
          });
        } else {
          data = encodeFunctionData({
            abi: zora1155Abi, functionName: "mintWithRewards",
            args: [this.zoraStrategy, plan.tokenId, qty, minterArguments, referral ?? "0x0000000000000000000000000000000000000000"],
          });
        }
        return { to: plan.address, data };
      }
      case "erc721a":
        return {
          to: plan.address,
          data: encodeFunctionData({ abi: erc721aMintAbi, functionName: plan.mintFn ?? "mint", args: [qty] }),
        };
      case "custom": {
        const fn = plan.customFn!;
        const args = coerceArgs(fn, t.customFunction?.args ?? [], { quantity: t.quantity, wallet });
        return { to: plan.address, data: encodeFunctionData({ abi: [fn], functionName: fn.name, args }) };
      }
    }
  }
}
