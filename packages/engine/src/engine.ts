import { randomUUID } from "node:crypto";
import { CHAIN_FAMILY, MAX_WALLETS_PER_JOB } from "@mint-engine/core";
import type {
  ChainAdapter, ChainFamily, CreateJobRequest, EngineEvent, GoLiveTrigger, JobStatus,
  JobView, MintJob, MintState, PreparedTx, SentTx, SimulationResult, TxOutcome, TxRouter, TxStatus,
  WalletSigner,
} from "@mint-engine/core";
import { checkFeeCap, estimateMaxTotalFee } from "./fees.js";
import { MemoryLedgerStore } from "./ledger.js";
import type { JobRecord, LedgerStore, WalletLedgerEntry, WalletLedgerState } from "./ledger.js";

export interface GoLiveContext {
  job: MintJob;
  adapter: ChainAdapter;
  /** Aborted when the job is cancelled. Implementations must reject promptly when it fires. */
  signal: AbortSignal;
  /** Report observed mint state; the engine emits it as `mint.state`. */
  onState: (state: MintState) => void;
  now: () => number;
}

/** Resolves when the mint is live. The watcher package can provide a richer implementation. */
export type WaitForGoLive = (trigger: GoLiveTrigger, ctx: GoLiveContext) => Promise<void>;

export interface EngineOptions {
  adapters: ChainAdapter[];
  routers: TxRouter[];
  getSigner: (walletId: string) => WalletSigner;
  waitForGoLive?: WaitForGoLive;
  /** Ledger persistence; in-memory by default. Use `JsonFileLedgerStore` to survive restarts. */
  store?: LedgerStore;
  now?: () => number;
  newJobId?: () => string;
  /** Prepare, simulate and sign all txs before go-live. Default true. */
  prearm?: boolean;
  /** For `time` triggers: start pre-arming this long before t0. Default 10s. */
  prearmLeadMs?: number;
  /** Max age of a pre-armed tx before it is re-prepared at fire time. */
  preparedTtlMs?: Partial<Record<ChainFamily, number>>;
  /** Custom staleness check (e.g. compare `validUntil` to the current block height). */
  isPreparedStale?: (tx: PreparedTx, armedAt: number) => boolean | Promise<boolean>;
  /** Worst-case fee estimator used for the `maxTotalFee` cap. */
  estimateTotalFee?: typeof estimateMaxTotalFee;
  confirmTimeoutMs?: number;
  /** Delay between retry rounds. Default 500ms. */
  retryDelayMs?: number;
  acceptPreconf?: boolean;
  defaultMaxRetries?: number;
}

export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

const DEFAULT_TTL: Record<ChainFamily, number> = { solana: 45_000, evm: 120_000 };
const MAX_RETRIES_LIMIT = 10;
const TERMINAL: JobStatus[] = ["done", "cancelled"];
const IN_FLIGHT: WalletLedgerState[] = ["sent", "preconfirmed"];

interface Armed {
  prepared: PreparedTx;
  signed: Uint8Array;
  sim: SimulationResult;
  armedAt: number;
}

interface Runtime {
  record: JobRecord;
  adapter: ChainAdapter;
  router: TxRouter;
  abort?: AbortController;
  running?: Promise<JobView>;
  saveChain: Promise<void>;
}

/** setTimeout clamps delays above 2^31-1 ms to 1 ms, so long sleeps are chunked. */
const MAX_TIMER_MS = 2_147_483_647;

function sleepOnce(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new EngineError("cancelled", "cancelled"));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(new EngineError("cancelled", "cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  const end = Date.now() + Math.max(0, ms);
  do {
    await sleepOnce(Math.min(end - Date.now(), MAX_TIMER_MS), signal);
  } while (Date.now() < end);
}

/** Built-in go-live: supports `now` and `time`. Other triggers need the watcher package. */
export const defaultWaitForGoLive: WaitForGoLive = async (trigger, ctx) => {
  if (trigger.type === "now") return;
  if (trigger.type === "time") return abortableSleep(trigger.at - ctx.now(), ctx.signal);
  throw new EngineError("unsupported_trigger", `trigger "${trigger.type}" requires an injected waitForGoLive (watcher)`);
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Engine {
  private readonly adapters: ChainAdapter[];
  private readonly routers: TxRouter[];
  private readonly getSigner: (walletId: string) => WalletSigner;
  private readonly waitForGoLive: WaitForGoLive;
  private readonly store: LedgerStore;
  private readonly now: () => number;
  private readonly opts: EngineOptions;
  private readonly jobs = new Map<string, Runtime>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.adapters = opts.adapters;
    this.routers = opts.routers;
    this.getSigner = opts.getSigner;
    this.waitForGoLive = opts.waitForGoLive ?? defaultWaitForGoLive;
    this.store = opts.store ?? new MemoryLedgerStore();
    this.now = opts.now ?? Date.now;
  }

  // ---------- events ----------

  /** Subscribe to engine events. Returns an unsubscribe function. */
  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: EngineEvent) {
    for (const l of this.listeners) {
      try { l(e); } catch { /* a bad listener must never break execution */ }
    }
  }

  private log(level: "info" | "warn" | "error", message: string, jobId?: string) {
    this.emit({ type: "log", jobId, level, message, at: this.now() });
  }

  // ---------- job lifecycle ----------

  createJob(req: CreateJobRequest): MintJob {
    const ids = req.walletIds ?? [];
    if (ids.length < 1 || ids.length > MAX_WALLETS_PER_JOB) {
      throw new EngineError("invalid_wallets", `a job needs 1..${MAX_WALLETS_PER_JOB} wallets, got ${ids.length}`);
    }
    if (new Set(ids).size !== ids.length) throw new EngineError("invalid_wallets", "duplicate wallet ids");
    const family = CHAIN_FAMILY[req.target.chain];
    if (!family) throw new EngineError("invalid_target", `unknown chain "${req.target.chain}"`);
    for (const id of ids) {
      let signer: WalletSigner;
      try { signer = this.getSigner(id); } catch (e) {
        throw new EngineError("wallet_unavailable", `wallet ${id}: ${errMsg(e)}`);
      }
      if (signer.wallet.family !== family) {
        throw new EngineError("wallet_family", `wallet ${id} is ${signer.wallet.family} but ${req.target.chain} is ${family}`);
      }
    }
    if (req.target.kind === "nft" && (!Number.isInteger(req.target.quantity) || req.target.quantity < 1)) {
      throw new EngineError("invalid_target", "quantity must be a positive integer");
    }
    const maxRetries = req.maxRetries ?? this.opts.defaultMaxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
      throw new EngineError("invalid_retries", `maxRetries must be an integer in 0..${MAX_RETRIES_LIMIT}`);
    }
    for (const k of ["priorityFee", "maxFee", "jitoTip", "maxTotalFee"] as const) {
      const v = req.fees?.[k];
      if (v !== undefined && !/^\d+$/.test(v)) {
        throw new EngineError("invalid_fees", `fees.${k} must be a non-negative integer string in base units, got "${v}"`);
      }
    }
    const adapter = this.adapters.find((a) => a.supports(req.target));
    if (!adapter) throw new EngineError("no_adapter", `no adapter for ${req.target.kind} on ${req.target.chain}`);
    const router = this.routers.find((r) => r.chains.includes(req.target.chain));
    if (!router) throw new EngineError("no_router", `no router for ${req.target.chain}`);

    const createdAt = this.now();
    const job: MintJob = {
      id: this.opts.newJobId?.() ?? randomUUID(),
      target: req.target, walletIds: [...ids], fees: { ...req.fees }, trigger: req.trigger, maxRetries, createdAt,
    };
    const wallets: Record<string, WalletLedgerEntry> = {};
    for (const id of ids) wallets[id] = { walletId: id, state: "pending", sends: 0, attempts: 0, txIds: [], updatedAt: createdAt };
    const rt: Runtime = { record: { job, status: "pending", wallets }, adapter, router, saveChain: Promise.resolve() };
    this.jobs.set(job.id, rt);
    void this.persist(rt).catch((e) => this.log("error", `ledger save failed: ${errMsg(e)}`, job.id));
    this.emit({ type: "job.created", jobId: job.id, at: createdAt });
    this.emit({ type: "job.status", jobId: job.id, status: "pending", at: createdAt });
    return job;
  }

  /** Resolves once every pending ledger write for the job is durable; rejects if the last write failed. */
  async flush(jobId: string): Promise<void> {
    const rt = await this.resolve(jobId);
    await this.persist(rt);
  }

  /** Load all persisted jobs (e.g. after a restart). Jobs are not resumed until `run` is called. */
  async restore(): Promise<JobView[]> {
    const out: JobView[] = [];
    for (const rec of await this.store.list()) {
      const rt = this.attach(rec);
      if (rt) out.push(this.view(rt));
    }
    return out;
  }

  get(jobId: string): JobView | undefined {
    const rt = this.jobs.get(jobId);
    return rt ? this.view(rt) : undefined;
  }

  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => a.record.job.createdAt - b.record.job.createdAt).map((rt) => this.view(rt));
  }

  /**
   * Run (or resume) a job. Safe to call again after a crash/restart: wallets whose tx was sent,
   * possibly sent, or confirmed are never sent again.
   */
  async run(jobId: string): Promise<JobView> {
    const rt = await this.resolve(jobId);
    if (rt.running) return rt.running;
    if (TERMINAL.includes(rt.record.status)) return this.view(rt);
    rt.abort = new AbortController();
    rt.running = this.pipeline(rt, rt.abort.signal)
      .catch(async (e) => {
        const cancelled = rt.abort?.signal.aborted ?? false;
        await this.setStatus(rt, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : errMsg(e)).catch(() => undefined);
        if (!cancelled) this.log("error", `job failed: ${errMsg(e)}`, jobId);
        return this.view(rt);
      })
      .finally(() => { rt.running = undefined; rt.abort = undefined; });
    return rt.running;
  }

  /** Cancel a job. Txs already handed to the router cannot be recalled; no further sends happen. */
  async cancel(jobId: string): Promise<JobView> {
    const rt = await this.resolve(jobId);
    if (TERMINAL.includes(rt.record.status)) return this.view(rt);
    if (rt.running && rt.abort) {
      rt.abort.abort();
      return rt.running;
    }
    await this.setStatus(rt, "cancelled", "cancelled");
    return this.view(rt);
  }

  // ---------- internals ----------

  private attach(rec: JobRecord): Runtime | undefined {
    const existing = this.jobs.get(rec.job.id);
    if (existing) return existing;
    const adapter = this.adapters.find((a) => a.supports(rec.job.target));
    const router = this.routers.find((r) => r.chains.includes(rec.job.target.chain));
    if (!adapter || !router) {
      this.log("warn", `cannot restore job ${rec.job.id}: no adapter/router for ${rec.job.target.chain}`, rec.job.id);
      return undefined;
    }
    for (const e of Object.values(rec.wallets)) e.attempts ??= e.sends;
    const rt: Runtime = { record: rec, adapter, router, saveChain: Promise.resolve() };
    this.jobs.set(rec.job.id, rt);
    return rt;
  }

  private async resolve(jobId: string): Promise<Runtime> {
    let rt = this.jobs.get(jobId);
    if (!rt) {
      const rec = await this.store.load(jobId);
      if (rec) rt = this.attach(rec);
    }
    if (!rt) throw new EngineError("not_found", `job ${jobId} not found`);
    return rt;
  }

  /** Serialized, durable save of the job record. Rejects if the store fails. */
  private persist(rt: Runtime): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(rt.record)) as JobRecord;
    const p = rt.saveChain.then(() => this.store.save(snapshot));
    rt.saveChain = p.catch(() => undefined);
    return p;
  }

  private async setStatus(rt: Runtime, status: JobStatus, detail?: string) {
    rt.record.status = status;
    rt.record.detail = detail;
    this.emit({ type: "job.status", jobId: rt.record.job.id, status, at: this.now(), detail });
    await this.persist(rt);
  }

  private txEvent(rt: Runtime, walletId: string, status: TxStatus, txId?: string, error?: string) {
    this.emit({ type: "tx.status", jobId: rt.record.job.id, walletId, status, txId, at: this.now(), error });
  }

  private entry(rt: Runtime, walletId: string): WalletLedgerEntry {
    const e = rt.record.wallets[walletId];
    if (!e) throw new EngineError("ledger", `no ledger entry for ${walletId}`);
    return e;
  }

  private eligible(rt: Runtime): string[] {
    const max = rt.record.job.maxRetries;
    return rt.record.job.walletIds.filter((id) => {
      const e = this.entry(rt, id);
      if (e.state === "pending") return e.attempts <= max;
      if (e.state === "failed" || e.state === "expired") return e.retryable !== false && e.attempts <= max;
      return false; // sending / sent / preconfirmed / confirmed / blocked: never (re)sent
    });
  }

  private async pipeline(rt: Runtime, signal: AbortSignal): Promise<JobView> {
    const { job } = rt.record;
    const checkAbort = () => { if (signal.aborted) throw new EngineError("cancelled", "cancelled"); };
    await this.persist(rt);

    // 1. Resume: anything already in flight from a previous run is confirmed, never resent.
    const resumed = job.walletIds.filter((id) => IN_FLIGHT.includes(this.entry(rt, id).state) && this.entry(rt, id).current);
    if (resumed.length) {
      this.log("info", `resuming: confirming ${resumed.length} in-flight tx(s) from a previous run`, job.id);
      await this.confirmAndRecord(rt, resumed.map((id) => this.entry(rt, id).current!));
    }
    for (const id of job.walletIds) {
      if (this.entry(rt, id).state === "sending") {
        this.log("warn", `wallet ${id}: previous send was interrupted with no recorded tx id; it will not be resent`, job.id);
      }
    }
    if (this.eligible(rt).length === 0) return this.finalize(rt);

    // A job that already went live in a previous run fires immediately: the go-live
    // event has passed and waiting for it again could block forever.
    const armed = new Map<string, Armed>();
    if (rt.record.firedAt === undefined) await this.beforeFire(rt, signal, armed);
    else this.log("info", "resuming a job that already went live; skipping go-live wait", job.id);
    checkAbort();
    rt.record.firedAt ??= this.now();
    await this.setStatus(rt, "firing");

    // 5. Fire rounds: first round sends every wallet at once; later rounds retry failed/expired only.
    for (let round = 0; ; round++) {
      const wallets = this.eligible(rt);
      if (wallets.length === 0 || signal.aborted) break;
      const retryDelay = this.opts.retryDelayMs ?? 500;
      if (round > 0 && retryDelay > 0) {
        try { await abortableSleep(retryDelay, signal); } catch { break; }
      }
      const ready: Array<{ walletId: string; armed: Armed }> = [];
      await Promise.all(wallets.map(async (id) => {
        const e = this.entry(rt, id);
        e.attempts += 1;
        try {
          let a = round === 0 ? armed.get(id) : undefined;
          if (a && (await this.isStale(a))) {
            this.log("info", `wallet ${id}: pre-armed tx expired; re-preparing`, job.id);
            a = undefined;
          }
          a ??= await this.arm(rt, id);
          if (!a.sim.ok) return this.markUnsent(rt, id, "failed", `simulation failed: ${a.sim.error ?? "unknown"}`, true);
          const feeErr = checkFeeCap(a.prepared, job.fees, a.sim, this.opts.estimateTotalFee);
          if (feeErr) return this.markUnsent(rt, id, "blocked", `fee cap: ${feeErr}`, false);
          ready.push({ walletId: id, armed: a });
        } catch (err) {
          this.markUnsent(rt, id, "failed", `prepare failed: ${errMsg(err)}`, true);
        }
      }));
      armed.clear();
      if (signal.aborted) {
        await this.persist(rt);
        break;
      }
      if (ready.length === 0) { await this.persist(rt); continue; }

      // Durably record intent BEFORE sending, so a crash mid-send can never lead to a resend.
      const order = job.walletIds.filter((id) => ready.some((r) => r.walletId === id));
      const byId = new Map(ready.map((r) => [r.walletId, r.armed]));
      for (const id of order) {
        const e = this.entry(rt, id);
        e.state = "sending"; e.sends += 1; e.error = undefined; e.outcome = undefined; e.current = undefined;
        e.updatedAt = this.now();
      }
      await this.persist(rt);

      const sent = await rt.router.send(order.map((id) => ({ prepared: byId.get(id)!.prepared, signed: byId.get(id)!.signed })), job.fees);
      const sentList: SentTx[] = [];
      for (const s of sent) {
        const e = rt.record.wallets[s.walletId];
        if (!e || e.state !== "sending") continue;
        e.state = "sent"; e.current = s; e.txIds.push(s.id); e.updatedAt = this.now();
        sentList.push(s);
      }
      for (const id of order) {
        const e = this.entry(rt, id);
        if (e.state === "sending") e.error = "router returned no tx id; not resending";
      }
      await this.persist(rt);
      for (const s of sentList) this.txEvent(rt, s.walletId, "sent", s.id);
      for (const id of order) {
        const e = this.entry(rt, id);
        if (e.state === "sending") this.txEvent(rt, id, "sent", undefined, e.error);
      }

      if (sentList.length) await this.confirmAndRecord(rt, sentList);
      if (round > MAX_RETRIES_LIMIT + 1) break; // defensive; eligibility already bounds rounds
    }

    // Cancelled with work left undone -> cancelled; if nothing was left to send, report the real result.
    if (signal.aborted && this.eligible(rt).length > 0) throw new EngineError("cancelled", "cancelled");
    return this.finalize(rt);
  }

  /** Steps 2-4: read mint state and enforce per-wallet limits, pre-arm, wait for go-live. */
  private async beforeFire(rt: Runtime, signal: AbortSignal, armed: Map<string, Armed>) {
    const { job } = rt.record;
    const checkAbort = () => { if (signal.aborted) throw new EngineError("cancelled", "cancelled"); };
    await this.setStatus(rt, "waiting");
    const state = await rt.adapter.detect(job.target);
    this.emit({ type: "mint.state", jobId: job.id, state, at: this.now() });
    if (job.target.kind === "nft" && state.maxPerWallet !== undefined && job.target.quantity > state.maxPerWallet) {
      throw new EngineError("per_wallet_limit", `quantity ${job.target.quantity} exceeds per-wallet limit ${state.maxPerWallet}`);
    }
    checkAbort();

    // 3. Pre-arm before t0 (best effort: some chains can't build/simulate until live).
    if (this.opts.prearm !== false) {
      if (job.trigger.type === "time") {
        await abortableSleep(job.trigger.at - (this.opts.prearmLeadMs ?? 10_000) - this.now(), signal);
      }
      await Promise.all(this.eligible(rt).map(async (id) => {
        try {
          const a = await this.arm(rt, id);
          if (a.sim.ok) armed.set(id, a);
          else this.log("warn", `wallet ${id}: pre-arm simulation failed (${a.sim.error ?? "unknown"}); will re-prepare at fire time`, job.id);
        } catch (e) {
          this.log("warn", `wallet ${id}: pre-arm failed (${errMsg(e)}); will prepare at fire time`, job.id);
        }
      }));
    }
    checkAbort();

    // 4. Wait for go-live.
    await this.waitForGoLive(job.trigger, {
      job, adapter: rt.adapter, signal, now: this.now,
      onState: (s) => this.emit({ type: "mint.state", jobId: job.id, state: s, at: this.now() }),
    });
  }


  private markUnsent(rt: Runtime, walletId: string, state: "failed" | "blocked", error: string, retryable: boolean) {
    const e = this.entry(rt, walletId);
    e.state = state; e.error = error; e.retryable = retryable; e.updatedAt = this.now();
    e.outcome = undefined;
    this.txEvent(rt, walletId, "failed", undefined, error);
    this.log("warn", `wallet ${walletId}: ${error}`, rt.record.job.id);
  }

  private async confirmAndRecord(rt: Runtime, sent: SentTx[]) {
    const outcomes = await rt.router.confirm(sent, {
      timeoutMs: this.opts.confirmTimeoutMs, acceptPreconf: this.opts.acceptPreconf,
    });
    for (const o of outcomes) {
      const e = rt.record.wallets[o.sent.walletId];
      if (!e || e.current?.id !== o.sent.id) continue;
      const st = o.status;
      e.state = st === "confirmed" || st === "failed" || st === "expired" || st === "preconfirmed" ? st : "sent";
      e.outcome = o; e.error = o.error; e.retryable = true; e.updatedAt = this.now();
      this.txEvent(rt, e.walletId, o.status, o.sent.id, o.error);
    }
    await this.persist(rt);
  }

  /** Prepare, simulate and sign one wallet's tx. */
  private async arm(rt: Runtime, walletId: string): Promise<Armed> {
    const { job } = rt.record;
    const signer = this.getSigner(walletId);
    const prepared = await rt.adapter.prepare(job.target, signer.wallet, job.fees);
    if (prepared.walletId !== walletId) throw new EngineError("adapter", `adapter returned tx for ${prepared.walletId}`);
    this.txEvent(rt, walletId, "prepared");
    const signed = await signer.signTransaction(prepared.unsigned);
    this.txEvent(rt, walletId, "signed");
    const sim = await rt.adapter.simulate(prepared, signed);
    return { prepared, signed, sim, armedAt: this.now() };
  }

  private async isStale(a: Armed): Promise<boolean> {
    if (this.opts.isPreparedStale) return this.opts.isPreparedStale(a.prepared, a.armedAt);
    const family = CHAIN_FAMILY[a.prepared.chain];
    const ttl = this.opts.preparedTtlMs?.[family] ?? DEFAULT_TTL[family];
    return this.now() - a.armedAt > ttl;
  }

  private async finalize(rt: Runtime): Promise<JobView> {
    const entries = rt.record.job.walletIds.map((id) => this.entry(rt, id));
    const ok = (e: WalletLedgerEntry) => e.state === "confirmed" || (this.opts.acceptPreconf === true && e.state === "preconfirmed");
    const confirmed = entries.filter(ok).length;
    const n = entries.length;
    if (confirmed === n) {
      await this.setStatus(rt, "done", `${confirmed}/${n} confirmed`);
    } else {
      const counts: Record<string, number> = {};
      for (const e of entries) if (!ok(e)) counts[e.state] = (counts[e.state] ?? 0) + 1;
      const rest = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
      await this.setStatus(rt, "failed", `${confirmed}/${n} confirmed; ${rest}`);
    }
    return this.view(rt);
  }

  private view(rt: Runtime): JobView {
    const outcomes: TxOutcome[] = [];
    for (const id of rt.record.job.walletIds) {
      const e = rt.record.wallets[id];
      if (!e || e.state === "pending") continue;
      if (e.outcome && e.current && e.outcome.sent.id === e.current.id) { outcomes.push(structuredClone(e.outcome)); continue; }
      const sent: SentTx = e.current ?? { chain: rt.record.job.target.chain, walletId: id, id: "", sentAt: e.updatedAt, via: [] };
      const status: TxStatus = e.state === "sending" ? "sent" : e.state === "blocked" ? "failed" : e.state;
      outcomes.push({ sent: { ...sent }, status, error: e.error });
    }
    return { job: structuredClone(rt.record.job), status: rt.record.status, outcomes };
  }
}

