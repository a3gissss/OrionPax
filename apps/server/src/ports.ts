// Interfaces the dashboard server depends on. Real implementations come from the
// engine and wallets packages; dev/test fakes live in ./dev-fakes.ts.

import type { CreateJobRequest, EngineEvent, JobView, WalletView } from "@mint-engine/core";

export type EngineListener = (event: EngineEvent) => void;

export interface EnginePort {
  /** Register a job (validated request, wallets already resolved to known ids). */
  createJob(req: CreateJobRequest): Promise<JobView>;
  /** Run a job to completion (waits on its trigger, fires, confirms). Resolves when terminal. */
  run(jobId: string): Promise<JobView>;
  /** Cancel a job. Returns undefined for unknown ids. */
  cancel(jobId: string): Promise<JobView | undefined>;
  list(): JobView[];
  /** Subscribe to engine events; returns an unsubscribe function. */
  on(listener: EngineListener): () => void;
}

export interface VaultPort {
  isUnlocked(): boolean;
  /** Wallets (public info only). Only called while unlocked. */
  list(): Promise<WalletView[]>;
  /** Returns true when the passphrase was accepted. Implementations must never log it. */
  unlock(passphrase: string): Promise<boolean>;
  lock(): Promise<void>;
}
