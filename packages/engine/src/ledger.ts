// Per-job, per-wallet ledger. It exists so that a crash or restart can never cause
// a second mint for a wallet that already has a sent (or possibly-sent) tx.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { JobStatus, MintJob, SentTx, TxOutcome } from "@mint-engine/core";

/**
 * Ledger state of one wallet within a job.
 * - `pending`: never handed to a router; safe to send.
 * - `sending`: handed to `router.send` but no tx id was recorded (crash/throw mid-send).
 *   The tx MAY be on chain, so it is never resent.
 * - `sent` / `preconfirmed`: in flight with a known tx id; never resent, only confirmed.
 * - `confirmed`: terminal success; never resent.
 * - `failed` / `expired`: the last tx did not land; may be retried within `maxRetries`.
 * - `blocked`: refused before send (fee cap, simulation, prepare error that cannot be retried).
 */
export type WalletLedgerState =
  | "pending" | "sending" | "sent" | "preconfirmed" | "confirmed" | "failed" | "expired" | "blocked";

export interface WalletLedgerEntry {
  walletId: string;
  state: WalletLedgerState;
  /** Number of times a tx for this wallet was handed to `router.send`. */
  sends: number;
  /** Number of fire rounds this wallet took part in (prepare/simulate/send). Bounded by 1 + maxRetries. */
  attempts: number;
  /** Every tx id ever recorded for this wallet, oldest first. */
  txIds: string[];
  /** The latest sent tx, when its id is known. */
  current?: SentTx;
  /** The latest outcome reported by the router. */
  outcome?: TxOutcome;
  error?: string;
  /** False for failures that retrying cannot fix (e.g. fee cap exceeded). */
  retryable?: boolean;
  updatedAt: number;
}

export interface JobRecord {
  job: MintJob;
  status: JobStatus;
  detail?: string;
  /** Set when the job first went live (entered "firing"); a resumed job then skips the go-live wait. */
  firedAt?: number;
  wallets: Record<string, WalletLedgerEntry>;
}

/** Durable storage for job ledgers. Implementations must persist `save` before resolving. */
export interface LedgerStore {
  load(jobId: string): Promise<JobRecord | undefined>;
  save(record: JobRecord): Promise<void>;
  list(): Promise<JobRecord[]>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Default store. Records are deep-copied so callers can't mutate stored state by reference. */
export class MemoryLedgerStore implements LedgerStore {
  private readonly records = new Map<string, JobRecord>();
  async load(jobId: string) {
    const r = this.records.get(jobId);
    return r ? clone(r) : undefined;
  }
  async save(record: JobRecord) {
    this.records.set(record.job.id, clone(record));
  }
  async list() {
    return [...this.records.values()].map(clone);
  }
}

/**
 * Stores all job ledgers in a single JSON file. Writes are serialized and atomic
 * (write temp file, then rename over the target). Assumes a single writer process per file.
 * Contains no secret material.
 */
export class JsonFileLedgerStore implements LedgerStore {
  private cache?: Record<string, JobRecord>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  private async read(): Promise<Record<string, JobRecord>> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { jobs?: Record<string, JobRecord> };
      this.cache = parsed.jobs ?? {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.cache = {};
    }
    return this.cache;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  load(jobId: string) {
    return this.serialize(async () => {
      const r = (await this.read())[jobId];
      return r ? clone(r) : undefined;
    });
  }

  list() {
    return this.serialize(async () => Object.values(await this.read()).map(clone));
  }

  save(record: JobRecord) {
    return this.serialize(async () => {
      // Only update the cache after the write is durable, so memory never runs ahead of disk.
      const jobs = { ...(await this.read()), [record.job.id]: clone(record) };
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, jobs }), "utf8");
      await rename(tmp, this.path);
      this.cache = jobs;
    });
  }
}
