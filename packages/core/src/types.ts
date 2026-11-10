// Shared contracts for every mint-engine package.
// Packages depend on each other ONLY through these types.

export type ChainId = "solana" | "ethereum" | "base" | "robinhood";
export type ChainFamily = "solana" | "evm";

export const CHAIN_FAMILY: Record<ChainId, ChainFamily> = {
  solana: "solana",
  ethereum: "evm",
  base: "evm",
  robinhood: "evm",
};

export interface ChainConfig {
  chain: ChainId;
  /** Primary RPC (HTTP). */
  rpcUrl: string;
  /** Extra RPCs for fan-out sends. */
  extraRpcUrls?: string[];
  wsUrl?: string;
  /** EVM numeric chain id (ignored for Solana). */
  evmChainId?: number;
  /** Solana: Jito block-engine URL. EVM L1: private relay URL (e.g. Flashbots Protect). */
  privateRelayUrl?: string;
}

// ---------- Mint targets ----------

export type MintKind = "nft" | "token";

export interface NftMintTarget {
  kind: "nft";
  chain: ChainId;
  /** Solana: Candy Machine address. EVM: collection contract address. */
  address: string;
  /** Units per wallet. Never exceeds the on-chain per-wallet limit. */
  quantity: number;
  /** Optional explicit mint style; adapters auto-detect when omitted. */
  style?: "core-candy-machine" | "seadrop" | "zora-1155" | "erc721a" | "custom";
  /** EVM 1155 token id, when relevant. */
  tokenId?: string;
  /** Custom ABI fragment / function name when style = "custom". */
  customFunction?: { signature: string; args: unknown[] };
  /** Solana Candy Machine guard-group label (e.g. "public"). Omit for the default guard set. */
  guardGroup?: string;
}

export interface TokenLaunchTarget {
  kind: "token";
  chain: ChainId;
  /** Token mint (Solana) / token contract (EVM). */
  tokenAddress: string;
  /** Launchpad / bonding-curve program or contract. */
  launchpadAddress: string;
  /** Amount of native currency to spend per wallet, in base units (lamports / wei) as decimal string. */
  spendPerWallet: string;
  /** Max slippage in basis points. */
  slippageBps: number;
  /** Which launchpad definition to use (e.g. "pumpfun", "generic-bonding-curve", "uniswap-v2-router").
   *  Adapters fall back to their address-based config when omitted. */
  launchpadKind?: string;
}

export type MintTarget = NftMintTarget | TokenLaunchTarget;

// ---------- Wallets ----------

export interface WalletRef {
  id: string;
  label: string;
  family: ChainFamily;
  /** Base58 (Solana) or 0x-checksummed (EVM) address. */
  address: string;
}

/** Signs on behalf of a wallet. Secret material never leaves the wallets package. */
export interface WalletSigner {
  wallet: WalletRef;
  /** Sign a serialized, unsigned transaction message; returns the signed serialized tx. */
  signTransaction(unsigned: Uint8Array): Promise<Uint8Array>;
}

// ---------- Transactions ----------

export interface FeeStrategy {
  /** Solana: micro-lamports per CU. EVM: maxPriorityFeePerGas in wei. Decimal string. */
  priorityFee?: string;
  /** EVM: maxFeePerGas cap in wei. */
  maxFee?: string;
  /** Solana Jito tip in lamports. */
  jitoTip?: string;
  /** Hard cap on total fee spend per tx, base units. */
  maxTotalFee?: string;
  /** Use private relay / bundle submission where supported. */
  privateSubmission?: boolean;
}

export interface PreparedTx {
  chain: ChainId;
  walletId: string;
  /**
   * Bytes the wallet signs.
   * - Solana: a full wire-format transaction. It may already carry other signatures (e.g. a fresh
   *   asset keypair); the wallet fills its own slot and keeps the rest.
   * - EVM: an unsigned serialized EIP-1559 transaction. The nonce may be a placeholder; the
   *   router/engine sets the real one (see `nonce`) before signing.
   */
  unsigned: Uint8Array;
  /** EVM nonce baked into `unsigned`, if the adapter assigned a real one. Undefined = placeholder. */
  nonce?: number;
  /** Native value sent, base units. */
  value: string;
  /** Estimated compute units (Solana) or gas (EVM). */
  computeOrGas?: number;
  /** L2 only: estimated L1 data fee in wei, charged on top of L2 gas. Counted against maxTotalFee. */
  l1DataFee?: string;
  /** Expiry hint: Solana lastValidBlockHeight / EVM deadline block. */
  validUntil?: number;
  /** Human-readable summary for the dashboard. */
  description: string;
}

export interface SimulationResult {
  ok: boolean;
  computeOrGasUsed?: number;
  error?: string;
  logs?: string[];
}

export type TxStatus = "prepared" | "signed" | "sent" | "preconfirmed" | "confirmed" | "failed" | "expired";

export interface SentTx {
  chain: ChainId;
  walletId: string;
  /** Signature (Solana) or tx hash (EVM). */
  id: string;
  sentAt: number;
  via: string[];
  /** Time from send start to first endpoint accepting it. */
  sendLatencyMs?: number;
  /** Last send error when no endpoint accepted the tx (via is empty). */
  error?: string;
}

export interface TxOutcome {
  sent: SentTx;
  status: TxStatus;
  slotOrBlock?: number;
  error?: string;
  confirmedAt?: number;
}

// ---------- Plug-in interfaces ----------

export interface MintState {
  live: boolean;
  /** Unix ms when the mint opens, if known. */
  startsAt?: number;
  /** Price per unit, base units. */
  pricePerUnit?: string;
  maxPerWallet?: number;
  remainingSupply?: number;
  detectedStyle?: string;
}

export interface ChainAdapter {
  readonly chain: ChainId;
  readonly kind: MintKind;
  /** True if this adapter can handle the target. */
  supports(target: MintTarget): boolean;
  /** Read on-chain mint state (live? price? limits?). */
  detect(target: MintTarget): Promise<MintState>;
  /** Build one unsigned tx for a wallet. */
  prepare(target: MintTarget, wallet: WalletRef, fees: FeeStrategy): Promise<PreparedTx>;
  simulate(tx: PreparedTx, signedTx?: Uint8Array): Promise<SimulationResult>;
}

export interface TxRouter {
  readonly chains: ChainId[];
  /** Broadcast signed txs as fast as possible (fan-out / bundles / private relay). */
  send(signed: Array<{ prepared: PreparedTx; signed: Uint8Array }>, fees: FeeStrategy): Promise<SentTx[]>;
  /**
   * Resolve when each tx reaches a terminal status or the timeout passes.
   * Contract: return "expired" ONLY when the tx can no longer land (e.g. Solana blockhash past
   * lastValidBlockHeight, bundle target blocks passed). A timeout returns the current status
   * ("sent"), never "expired"; the engine retries expired wallets, so a wrong "expired" can double-mint.
   * `acceptPreconf`: resolve on a sequencer preconfirmation where one exists. Base has no separate
   * preconf since the Denim upgrade (200 ms canonical blocks, 5 Nov 2026), so it is a no-op there.
   */
  confirm(
    sent: SentTx[],
    opts?: { timeoutMs?: number; acceptPreconf?: boolean; onUpdate?: (outcome: TxOutcome) => void },
  ): Promise<TxOutcome[]>;
}

export type GoLiveTrigger =
  | { type: "now" }
  | { type: "time"; at: number }
  | { type: "state-poll"; intervalMs: number }
  | { type: "event"; signature?: string }
  | { type: "slot-or-block"; at: number };

// ---------- Jobs & events ----------

export interface MintJob {
  id: string;
  target: MintTarget;
  walletIds: string[]; // 1..10
  fees: FeeStrategy;
  trigger: GoLiveTrigger;
  maxRetries: number;
  createdAt: number;
}

export type JobStatus = "pending" | "waiting" | "firing" | "done" | "failed" | "cancelled";

export type EngineEvent =
  | { type: "job.created"; jobId: string; at: number }
  | { type: "job.status"; jobId: string; status: JobStatus; at: number; detail?: string }
  | { type: "mint.state"; jobId: string; state: MintState; at: number }
  | { type: "tx.status"; jobId: string; walletId: string; status: TxStatus; txId?: string; at: number; error?: string }
  | { type: "log"; jobId?: string; level: "info" | "warn" | "error"; message: string; at: number };

export const MAX_WALLETS_PER_JOB = 10;
