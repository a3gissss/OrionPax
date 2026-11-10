// Real backend for the dashboard server: the engine + wallet vault + chain packages,
// wired from a JSON config. The dev fakes in ./dev-fakes.ts stay for tests and demos.

import { readFile } from "node:fs/promises";
import {
  CHAIN_FAMILY,
  type ChainAdapter, type ChainConfig, type ChainFamily, type ChainId, type CreateJobRequest,
  type JobView, type PreparedTx, type TxRouter, type WalletRef, type WalletView,
} from "@mint-engine/core";
import { Engine, JsonFileLedgerStore, type WaitForGoLive } from "@mint-engine/engine";
import { WalletVault, WrongPassphraseError } from "@mint-engine/wallets";
import { waitForGoLive as watcherWaitForGoLive } from "@mint-engine/watcher";
import { SolanaCoreCandyMachineAdapter } from "@mint-engine/chain-solana-nft";
import { SolanaTokenAdapter, createPumpFunLaunchpad } from "@mint-engine/chain-solana-token";
import { SolanaTxRouter } from "@mint-engine/router-solana";
import { EvmNftAdapter } from "@mint-engine/chain-evm-nft";
import { EvmTokenAdapter } from "@mint-engine/chain-evm-token";
import { EvmL1Router, patchPrepared } from "@mint-engine/router-evm-l1";
import { L2Router } from "@mint-engine/router-evm-l2";
import type { EngineListener, EnginePort, VaultPort } from "./ports.js";

export interface RealConfig {
  /** Encrypted keystore file (create it with the vault CLI: `npm run vault -w @mint-engine/server`). */
  vaultPath: string;
  /** Job ledger (crash-safe idempotency). Strongly recommended for real funds. */
  ledgerPath?: string;
  /** RPC config per chain. Only chains listed here are enabled. */
  chains: Partial<Record<ChainId, Omit<ChainConfig, "chain">>>;
  /**
   * pump.fun-compatible program id for Solana token launches. Omitted = Solana token launches
   * disabled. NOTE: the bundled definition matches pump.fun's older buy layout; the live
   * mainnet program needs its own LaunchpadDefinition.
   */
  pumpfunProgramId?: string;
  /** EVM launchpad contract address -> launchpad definition id, per chain. */
  evmLaunchpads?: Partial<Record<ChainId, Record<string, string>>>;
}

export async function loadConfig(path: string): Promise<RealConfig> {
  const cfg = JSON.parse(await readFile(path, "utf8")) as RealConfig;
  if (!cfg.vaultPath) throw new Error(`${path}: vaultPath is required`);
  if (!cfg.chains || Object.keys(cfg.chains).length === 0) throw new Error(`${path}: configure at least one chain`);
  for (const [chain, c] of Object.entries(cfg.chains)) {
    if (!(chain in CHAIN_FAMILY)) throw new Error(`${path}: unknown chain "${chain}"`);
    if (!c?.rpcUrl) throw new Error(`${path}: chains.${chain}.rpcUrl is required`);
  }
  return cfg;
}

const chainCfg = (cfg: RealConfig, chain: ChainId): ChainConfig | undefined => {
  const c = cfg.chains[chain];
  return c ? { ...c, chain } : undefined;
};

/** Minimal JSON-RPC call (used for nonces, heights and chain time). */
async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result as T;
}

export function buildAdapters(cfg: RealConfig): ChainAdapter[] {
  const out: ChainAdapter[] = [];
  const sol = chainCfg(cfg, "solana");
  if (sol) {
    out.push(new SolanaCoreCandyMachineAdapter(sol));
    if (cfg.pumpfunProgramId) {
      out.push(new SolanaTokenAdapter({ config: sol, launchpads: [createPumpFunLaunchpad({ programId: cfg.pumpfunProgramId })] }));
    }
  }
  for (const chain of ["ethereum", "base", "robinhood"] as const) {
    const c = chainCfg(cfg, chain);
    if (!c) continue;
    out.push(new EvmNftAdapter(c));
    out.push(new EvmTokenAdapter({ chain, rpcUrl: c.rpcUrl, evmChainId: c.evmChainId, launchpads: cfg.evmLaunchpads?.[chain] }));
  }
  return out;
}

export function buildRouters(cfg: RealConfig): TxRouter[] {
  const out: TxRouter[] = [];
  const sol = chainCfg(cfg, "solana");
  if (sol) out.push(new SolanaTxRouter(sol));
  const eth = chainCfg(cfg, "ethereum");
  if (eth) out.push(new EvmL1Router({ config: eth }));
  const l2 = (["base", "robinhood"] as const).map((c) => chainCfg(cfg, c)).filter((c): c is ChainConfig => !!c);
  if (l2.length) out.push(new L2Router(l2));
  return out;
}

/**
 * EVM adapters leave a placeholder nonce. Set the wallet's pending nonce right before
 * signing. A wallet never has two txs in flight (the engine only re-arms failed/expired
 * wallets), so the pending count is the right nonce.
 */
export function makeBeforeSign(cfg: RealConfig) {
  return async (tx: PreparedTx, wallet: WalletRef): Promise<PreparedTx> => {
    if (CHAIN_FAMILY[tx.chain] !== "evm" || tx.nonce !== undefined) return tx;
    const c = chainCfg(cfg, tx.chain);
    if (!c) throw new Error(`no RPC configured for ${tx.chain}`);
    const nonce = Number(BigInt(await rpc<string>(c.rpcUrl, "eth_getTransactionCount", [wallet.address, "pending"])));
    return { ...patchPrepared(tx, { nonce }), nonce };
  };
}

/** Go-live via the watcher package: now, time, state-poll and slot-or-block. */
export function makeWaitForGoLive(cfg: RealConfig): WaitForGoLive {
  return async (trigger, ctx) => {
    const c = chainCfg(cfg, ctx.job.target.chain);
    if (!c) throw new Error(`no RPC configured for ${ctx.job.target.chain}`);
    if (trigger.type === "event") {
      throw new Error("event triggers aren't wired to a chain subscription yet; use state-poll, time or slot-or-block");
    }
    const evm = CHAIN_FAMILY[ctx.job.target.chain] === "evm";
    await watcherWaitForGoLive(trigger, {
      jobId: ctx.job.id,
      adapter: ctx.adapter,
      target: ctx.job.target,
      emit: (e) => { if (e.type === "mint.state") ctx.onState(e.state); },
      getHeight: evm
        ? async () => Number(BigInt(await rpc<string>(c.rpcUrl, "eth_blockNumber")))
        : async () => rpc<number>(c.rpcUrl, "getSlot", [{ commitment: "confirmed" }]),
      getChainTime: evm
        ? async () => Number(BigInt((await rpc<{ timestamp: string }>(c.rpcUrl, "eth_getBlockByNumber", ["latest", false])).timestamp)) * 1000
        : undefined,
    }, {
      signal: ctx.signal,
      // EVM block timestamps are whole seconds and already old; see the watcher README.
      chainTimeBiasMs: evm ? 1500 : undefined,
    });
  };
}

class VaultAdapter implements VaultPort {
  constructor(private readonly vault: WalletVault, private readonly cfg: RealConfig) {}
  isUnlocked(): boolean { return this.vault.isUnlocked; }
  async list(): Promise<WalletView[]> {
    const chainsFor = (family: ChainFamily) => (Object.keys(this.cfg.chains) as ChainId[])
      .filter((c) => CHAIN_FAMILY[c] === family)
      .map((c) => ({ chain: c, rpcUrl: this.cfg.chains[c]!.rpcUrl }));
    return Promise.all(this.vault.list().map(async (w) => ({ ...w, balances: await this.vault.getBalances(w.id, chainsFor(w.family)) })));
  }
  async unlock(passphrase: string): Promise<boolean> {
    try { await this.vault.unlock(passphrase); return true; }
    catch (e) { if (e instanceof WrongPassphraseError) return false; throw e; }
  }
  async lock(): Promise<void> { this.vault.lock(); }
}

class EngineAdapter implements EnginePort {
  constructor(private readonly engine: Engine) {}
  async createJob(req: CreateJobRequest): Promise<JobView> {
    const job = this.engine.createJob(req);
    await this.engine.flush(job.id); // persisted before the server acknowledges it
    return this.engine.get(job.id)!;
  }
  run(jobId: string): Promise<JobView> { return this.engine.run(jobId); }
  async cancel(jobId: string): Promise<JobView | undefined> {
    if (!this.engine.get(jobId)) return undefined;
    return this.engine.cancel(jobId);
  }
  list(): JobView[] { return this.engine.list(); }
  on(listener: EngineListener): () => void { return this.engine.on(listener); }
}

export interface RealBackend {
  engine: EnginePort;
  vault: VaultPort;
  /** Jobs restored from the ledger (resumed without re-sending already-sent wallets). */
  restored: JobView[];
}

export async function createRealBackend(cfg: RealConfig): Promise<RealBackend> {
  const vault = await WalletVault.open(cfg.vaultPath);
  const engine = new Engine({
    adapters: buildAdapters(cfg),
    routers: buildRouters(cfg),
    getSigner: (id) => vault.signer(id),
    store: cfg.ledgerPath ? new JsonFileLedgerStore(cfg.ledgerPath) : undefined,
    beforeSign: makeBeforeSign(cfg),
    waitForGoLive: makeWaitForGoLive(cfg),
  });
  const restored = await engine.restore();
  return { engine: new EngineAdapter(engine), vault: new VaultAdapter(vault, cfg), restored };
}
