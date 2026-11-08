// Dashboard API contract shared by apps/server and apps/web.
// Server binds to 127.0.0.1 only.

import type { ChainId, EngineEvent, FeeStrategy, GoLiveTrigger, JobStatus, MintJob, MintTarget, TxOutcome, WalletRef } from "./types.js";

export const DEFAULT_SERVER_PORT = 4810;
export const WS_PATH = "/ws";

export interface WalletView extends WalletRef {
  balances: Partial<Record<ChainId, string>>;
}

export interface CreateJobRequest {
  target: MintTarget;
  walletIds: string[];
  fees: FeeStrategy;
  trigger: GoLiveTrigger;
  maxRetries?: number;
}

export interface JobView {
  job: MintJob;
  status: JobStatus;
  outcomes: TxOutcome[];
}

/** REST routes (all JSON). */
export interface ApiRoutes {
  "GET /api/wallets": { res: WalletView[] };
  "POST /api/vault/unlock": { req: { passphrase: string }; res: { ok: boolean } };
  "POST /api/vault/lock": { res: { ok: boolean } };
  "GET /api/jobs": { res: JobView[] };
  "POST /api/jobs": { req: CreateJobRequest; res: JobView };
  "POST /api/jobs/:id/cancel": { res: JobView };
}

/** Messages pushed over the WebSocket. */
export type WsServerMessage = { type: "event"; event: EngineEvent } | { type: "snapshot"; jobs: JobView[] };
