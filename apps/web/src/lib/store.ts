// Client-side job/timeline state fed by REST snapshots and WS events.
import type { EngineEvent, JobStatus, JobView, MintState, TxStatus, WsServerMessage } from "@mint-engine/core";

export const TX_STAGES: TxStatus[] = ["prepared", "signed", "sent", "preconfirmed", "confirmed"];
const RANK: Record<TxStatus, number> = { prepared: 0, signed: 1, sent: 2, preconfirmed: 3, confirmed: 4, failed: 4, expired: 4 };
export const TERMINAL_TX: TxStatus[] = ["confirmed", "failed", "expired"];
export const ACTIVE_JOB: JobStatus[] = ["pending", "waiting", "firing"];
const JOB_RANK: Record<JobStatus, number> = { pending: 0, waiting: 1, firing: 2, done: 3, failed: 3, cancelled: 3 };

export interface WalletTimeline {
  walletId: string;
  status: TxStatus;
  stages: Partial<Record<TxStatus, number>>;
  txId?: string;
  error?: string;
  /** 1-based attempt counter; bumps when a retry starts after a failed/expired attempt. */
  attempt: number;
}

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
  jobId?: string;
}

export interface JobsState {
  jobs: Record<string, JobView>;
  timelines: Record<string, Record<string, WalletTimeline>>;
  mintState: Record<string, MintState>;
  statusDetail: Record<string, string>;
  /** Latest job status seen over WS, kept even for jobs not yet loaded via REST. */
  eventStatus: Record<string, JobStatus>;
  logs: LogLine[];
}

export const initialJobsState: JobsState = { jobs: {}, timelines: {}, mintState: {}, statusDetail: {}, eventStatus: {}, logs: [] };

export type JobsAction =
  | { type: "ws"; msg: WsServerMessage }
  | { type: "upsert"; job: JobView }
  | { type: "replace"; jobs: JobView[] }
  | { type: "reset" };

const MAX_LOGS = 300;

function mergeOutcomes(prev: Record<string, WalletTimeline> | undefined, view: JobView): Record<string, WalletTimeline> {
  const next: Record<string, WalletTimeline> = { ...prev };
  for (const o of view.outcomes) {
    const wid = o.sent.walletId;
    const cur = next[wid];
    const stages: Partial<Record<TxStatus, number>> = { ...cur?.stages };
    stages.sent ??= o.sent.sentAt;
    if (o.confirmedAt !== undefined) stages[o.status] ??= o.confirmedAt;
    const status = cur && RANK[cur.status] > RANK[o.status] ? cur.status : o.status;
    next[wid] = {
      walletId: wid, status, stages, attempt: cur?.attempt ?? 1,
      txId: o.sent.id || cur?.txId,
      error: status === "confirmed" ? undefined : o.error ?? cur?.error,
    };
  }
  return next;
}

function applyEvent(s: JobsState, e: EngineEvent): JobsState {
  switch (e.type) {
    case "job.status": {
      const job = s.jobs[e.jobId];
      const statusDetail = e.detail ? { ...s.statusDetail, [e.jobId]: e.detail } : s.statusDetail;
      const eventStatus = { ...s.eventStatus, [e.jobId]: e.status };
      if (!job) return { ...s, statusDetail, eventStatus };
      return { ...s, statusDetail, eventStatus, jobs: { ...s.jobs, [e.jobId]: { ...job, status: e.status } } };
    }
    case "tx.status": {
      const tl = s.timelines[e.jobId] ?? {};
      let cur = tl[e.walletId];
      // A new "prepared" after a failed/expired attempt starts a retry: reset the row.
      const retry = cur && e.status === "prepared" && (cur.status === "failed" || cur.status === "expired");
      const attempt = (cur?.attempt ?? 1) + (retry ? 1 : 0);
      if (retry) cur = undefined;
      const stages = { ...cur?.stages, [e.status]: cur?.stages[e.status] ?? e.at };
      // Keep the most advanced status even if events arrive out of order.
      const status = cur && RANK[cur.status] > RANK[e.status] ? cur.status : e.status;
      const next: WalletTimeline = {
        walletId: e.walletId, status, stages, attempt,
        txId: e.txId ?? cur?.txId,
        error: status === "confirmed" ? undefined : e.error ?? cur?.error,
      };
      return { ...s, timelines: { ...s.timelines, [e.jobId]: { ...tl, [e.walletId]: next } } };
    }
    case "mint.state":
      return { ...s, mintState: { ...s.mintState, [e.jobId]: e.state } };
    case "log":
      return { ...s, logs: [...s.logs, { at: e.at, level: e.level, message: e.message, jobId: e.jobId }].slice(-MAX_LOGS) };
    case "job.created":
      return { ...s, logs: [...s.logs, { at: e.at, level: "info" as const, message: `job ${e.jobId} created`, jobId: e.jobId }].slice(-MAX_LOGS) };
  }
}

function withJobs(s: JobsState, views: JobView[], replace: boolean): JobsState {
  const jobs: Record<string, JobView> = replace ? {} : { ...s.jobs };
  const timelines = { ...s.timelines };
  for (const v of views) {
    // A REST view may be older than WS events already applied: never roll the status back.
    const seen = [s.jobs[v.job.id]?.status, s.eventStatus[v.job.id]].filter((x): x is JobStatus => !!x);
    let status = v.status;
    for (const st of seen) if (JOB_RANK[st] > JOB_RANK[status]) status = st;
    jobs[v.job.id] = status === v.status ? v : { ...v, status };
    timelines[v.job.id] = mergeOutcomes(timelines[v.job.id], v);
  }
  return { ...s, jobs, timelines };
}

export function jobsReducer(s: JobsState, a: JobsAction): JobsState {
  switch (a.type) {
    case "reset":
      return initialJobsState;
    case "replace":
      return withJobs(s, a.jobs, true);
    case "upsert":
      return withJobs(s, [a.job], false);
    case "ws":
      return a.msg.type === "snapshot" ? withJobs(s, a.msg.jobs, true) : applyEvent(s, a.msg.event);
  }
}

export function sortedJobs(s: JobsState): JobView[] {
  return Object.values(s.jobs).sort((a, b) => b.job.createdAt - a.job.createdAt);
}

export function jobProgress(s: JobsState, view: JobView): { confirmed: number; failed: number; total: number } {
  const tl = s.timelines[view.job.id] ?? {};
  let confirmed = 0;
  let failed = 0;
  for (const w of view.job.walletIds) {
    const st = tl[w]?.status;
    if (st === "confirmed") confirmed++;
    else if (st === "failed" || st === "expired") failed++;
  }
  return { confirmed, failed, total: view.job.walletIds.length };
}
