// In-memory EnginePort / VaultPort for `npm run dev` and tests. No chains, no keys.

import { randomUUID } from "node:crypto";
import {
  CHAIN_FAMILY, MockAdapter, MockRouter, mockSigner, mockWallets,
  type ChainId, type CreateJobRequest, type EngineEvent, type JobStatus, type JobView, type MintJob,
  type TxOutcome, type WalletRef, type WalletView,
} from "@mint-engine/core";
import type { EngineListener, EnginePort, VaultPort } from "./ports.js";

export const DEV_PASSPHRASE = "dev-passphrase";

export class FakeVault implements VaultPort {
  private unlocked = false;
  private readonly wallets: WalletView[];
  constructor(private readonly passphrase = DEV_PASSPHRASE, walletCount = 10) {
    this.wallets = mockWallets(walletCount, "evm").map((w) => ({ ...w, balances: { base: "1000000000000000000" } }));
  }
  /** Public wallet refs, for wiring a FakeEngine to the same wallet set. */
  refs(): WalletRef[] {
    return this.wallets.map(({ balances: _b, ...ref }) => ref);
  }
  isUnlocked() { return this.unlocked; }
  async list() { return this.wallets.map((w) => ({ ...w, balances: { ...w.balances } })); }
  async unlock(passphrase: string) {
    // A failed attempt never changes state (doesn't re-lock an unlocked vault).
    if (passphrase !== this.passphrase) return false;
    this.unlocked = true;
    return true;
  }
  async lock() { this.unlocked = false; }
}

const TERMINAL: JobStatus[] = ["done", "failed", "cancelled"];
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface FakeEngineOptions {
  /** Delay between simulated steps, ms. Default 25. */
  stepDelayMs?: number;
  /** walletIds whose txs fail. */
  failWallets?: string[];
  /** Wallet set (should match the vault's). Default mockWallets(10, "evm"). */
  wallets?: WalletRef[];
}

interface JobEntry {
  view: JobView;
  /** Wakes a pending sleep early (on cancel). */
  wake?: () => void;
}

export class FakeEngine implements EnginePort {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly listeners = new Set<EngineListener>();
  private readonly stepDelayMs: number;
  private readonly wallets: Map<string, WalletRef>;
  readonly router = new MockRouter(Object.keys(CHAIN_FAMILY) as ChainId[]);

  constructor(opts: FakeEngineOptions = {}) {
    this.stepDelayMs = opts.stepDelayMs ?? 25;
    this.wallets = new Map((opts.wallets ?? mockWallets(10, "evm")).map((w) => [w.id, w]));
    for (const w of opts.failWallets ?? []) this.router.failWallets.add(w);
  }

  on(listener: EngineListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((e) => structuredClone(e.view));
  }

  async createJob(req: CreateJobRequest): Promise<JobView> {
    const job: MintJob = {
      id: randomUUID(), target: req.target, walletIds: [...req.walletIds], fees: req.fees,
      trigger: req.trigger, maxRetries: req.maxRetries ?? 2, createdAt: Date.now(),
    };
    const view: JobView = { job, status: "pending", outcomes: [] };
    this.jobs.set(job.id, { view });
    this.emit({ type: "job.created", jobId: job.id, at: Date.now() });
    return structuredClone(view);
  }

  async cancel(jobId: string): Promise<JobView | undefined> {
    const entry = this.jobs.get(jobId);
    if (!entry) return undefined;
    if (!TERMINAL.includes(entry.view.status)) {
      this.setStatus(entry.view, "cancelled");
      entry.wake?.();
    }
    return structuredClone(entry.view);
  }

  async run(jobId: string): Promise<JobView> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`unknown job ${jobId}`);
    const { view } = entry;
    const { job } = view;
    const live = () => !TERMINAL.includes(view.status);
    const done = () => structuredClone(view);

    this.setStatus(view, "waiting");
    const until = job.trigger.type === "time" ? job.trigger.at : Date.now() + this.stepDelayMs;
    if (!(await this.sleepUntil(entry, until))) return done();

    const adapter = new MockAdapter(job.target.chain, job.target.kind);
    this.emit({ type: "mint.state", jobId, state: await adapter.detect(), at: Date.now() });
    if (!live()) return done();
    this.setStatus(view, "firing");

    const signed = [];
    for (const id of job.walletIds) {
      const wallet = this.wallets.get(id);
      if (!wallet) throw new Error(`unknown wallet ${id}`);
      const prepared = await adapter.prepare(job.target, wallet, job.fees);
      this.tx(jobId, id, "prepared");
      signed.push({ prepared, signed: await mockSigner(wallet).signTransaction(prepared.unsigned) });
      this.tx(jobId, id, "signed");
    }
    if (!live()) return done();
    const sent = await this.router.send(signed);
    for (const s of sent) this.tx(jobId, s.walletId, "sent", s.id);
    await this.sleepUntil(entry, Date.now() + this.stepDelayMs);

    // Already-broadcast txs still get confirmed, but a cancel is never overwritten.
    const outcomes: TxOutcome[] = await this.router.confirm(sent);
    view.outcomes = outcomes;
    for (const o of outcomes) this.tx(jobId, o.sent.walletId, o.status, o.sent.id, o.error);
    if (live()) this.setStatus(view, outcomes.every((o) => o.status === "confirmed") ? "done" : "failed");
    return done();
  }

  private tx(jobId: string, walletId: string, status: TxOutcome["status"], txId?: string, error?: string) {
    this.emit({
      type: "tx.status", jobId, walletId, status, at: Date.now(),
      ...(txId ? { txId } : {}), ...(error ? { error } : {}),
    });
  }

  private setStatus(view: JobView, status: JobStatus) {
    view.status = status;
    this.emit({ type: "job.status", jobId: view.job.id, status, at: Date.now() });
  }

  private emit(event: EngineEvent) {
    for (const l of this.listeners) {
      try { l(event); } catch { /* listener errors must not break the engine */ }
    }
  }

  /** Sleep until `at` (chunked past the setTimeout limit); false if the job was cancelled meanwhile. */
  private async sleepUntil(entry: JobEntry, at: number): Promise<boolean> {
    while (!TERMINAL.includes(entry.view.status)) {
      const remaining = at - Date.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, MAX_TIMER_MS));
        entry.wake = () => { clearTimeout(timer); resolve(); };
      });
      entry.wake = undefined;
    }
    return false;
  }
}
