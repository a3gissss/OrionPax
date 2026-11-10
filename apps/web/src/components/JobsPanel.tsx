import { forwardRef, useState } from "react";
import type { JobStatus, JobView, TxStatus, WalletView } from "@mint-engine/core";
import { ACTIVE_JOB, TX_STAGES, jobProgress, type JobsState, type LogLine } from "../lib/store";
import { CHAIN_LABEL } from "../lib/form";
import { fmtTime } from "../lib/units";
import { Badge, Mono, Panel } from "./common";

const JOB_BADGE: Record<JobStatus, string> = { pending: "muted", waiting: "warn", firing: "info", done: "ok", failed: "err", cancelled: "muted" };
const TX_BADGE: Record<TxStatus, string> = { prepared: "muted", signed: "muted", sent: "info", preconfirmed: "info", confirmed: "ok", failed: "err", expired: "err" };

function targetLabel(v: JobView): string {
  const t = v.job.target;
  return t.kind === "nft" ? `NFT ×${t.quantity}` : "Token";
}

interface ListProps {
  state: JobsState;
  jobs: JobView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCancel: (id: string) => Promise<void>;
}

export const JobsList = forwardRef<HTMLDivElement, ListProps>(function JobsList({ state, jobs, selectedId, onSelect, onCancel }, ref) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const move = (d: number) => {
    if (jobs.length === 0) return;
    const i = jobs.findIndex((j) => j.job.id === selectedId);
    const next = jobs[Math.min(jobs.length - 1, Math.max(0, i + d))];
    if (next) onSelect(next.job.id);
  };
  return (
    <Panel title="Jobs" id="jobs" right={<span className="kbd-hint">Alt+J · ↑/↓ · X cancel</span>}>
      <div
        className="table-wrap jobs-list"
        tabIndex={0}
        ref={ref}
        aria-label="Jobs list"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
          if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
          if ((e.key === "x" || e.key === "Delete") && selectedId) {
            const v = state.jobs[selectedId];
            if (v && ACTIVE_JOB.includes(v.status)) { e.preventDefault(); void onCancel(selectedId); }
          }
        }}
      >
        <table className="grid-table" aria-label="Jobs">
          <thead>
            <tr><th>Job</th><th>Chain</th><th>Target</th><th>Status</th><th className="num">Conf</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {jobs.map((v) => {
              const p = jobProgress(state, v);
              const active = ACTIVE_JOB.includes(v.status);
              return (
                <tr
                  key={v.job.id}
                  className={v.job.id === selectedId ? "selected" : undefined}
                  onClick={() => onSelect(v.job.id)}
                  aria-selected={v.job.id === selectedId}
                >
                  <td className="mono">{v.job.id}</td>
                  <td>{CHAIN_LABEL[v.job.target.chain]}</td>
                  <td>{targetLabel(v)}</td>
                  <td><Badge kind={JOB_BADGE[v.status]}>{v.status}</Badge></td>
                  <td className="num mono" data-testid={`progress-${v.job.id}`}>
                    {p.confirmed}/{p.total}{p.failed ? <span className="err-text"> ✕{p.failed}</span> : null}
                  </td>
                  <td className="mono muted">{fmtTime(v.job.createdAt)}</td>
                  <td>
                    {active && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={cancelling === v.job.id}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setCancelling(v.job.id);
                          try { await onCancel(v.job.id); } finally { setCancelling(null); }
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {jobs.length === 0 && <tr><td colSpan={7} className="muted">No jobs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
});

export function Timeline({ state, view, wallets }: { state: JobsState; view: JobView | null; wallets: WalletView[] }) {
  if (!view) {
    return <Panel title="Timeline" id="timeline"><div className="muted">Select a job to see the per-wallet timeline.</div></Panel>;
  }
  const tl = state.timelines[view.job.id] ?? {};
  const detail = state.statusDetail[view.job.id];
  const ms = state.mintState[view.job.id];
  const p = jobProgress(state, view);
  const t0 = Math.min(...view.job.walletIds.map((w) => tl[w]?.stages.prepared ?? Infinity));
  return (
    <Panel
      title={<>Timeline <span className="mono muted">{view.job.id}</span></>}
      id="timeline"
      right={
        <>
          {ms && <Badge kind={ms.live ? "ok" : "warn"}>{ms.live ? "mint live" : "mint not live"}</Badge>}
          <Badge kind={JOB_BADGE[view.status]}>{view.status}</Badge>
          <span className="mono" data-testid="timeline-summary">{p.confirmed}/{p.total} confirmed{p.failed ? ` · ${p.failed} failed` : ""}</span>
        </>
      }
    >
      {detail && <div className="muted detail">{detail}</div>}
      <div className="table-wrap">
        <table className="grid-table timeline" aria-label="Per-wallet timeline">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Status</th>
              {TX_STAGES.map((st) => <th key={st} className="num">{st}</th>)}
              <th>Tx id</th>
            </tr>
          </thead>
          <tbody>
            {view.job.walletIds.map((wid) => {
              const row = tl[wid];
              const w = wallets.find((x) => x.id === wid);
              return (
                <tr key={wid} data-status={row?.status ?? "queued"}>
                  <td>{w?.label ?? wid}{row && row.attempt > 1 && <span className="muted small"> try {row.attempt}</span>}</td>
                  <td><Badge kind={row ? TX_BADGE[row.status] : "muted"}>{row?.status ?? "queued"}</Badge></td>
                  {TX_STAGES.map((st) => {
                    const at = row?.stages[st];
                    const failedHere = row && (row.status === "failed" || row.status === "expired") && st === "confirmed";
                    return (
                      <td key={st} className={`num mono stage${at !== undefined ? " hit" : ""}`} title={at !== undefined ? new Date(at).toISOString() : undefined}>
                        {failedHere ? <span className="err-text">✕ {row.stages[row.status] !== undefined ? fmtTime(row.stages[row.status]!) : ""}</span>
                          : at === undefined ? <span className="muted">·</span>
                          : <>{fmtTime(at)}{Number.isFinite(t0) && <span className="delta"> +{at - t0}ms</span>}</>}
                      </td>
                    );
                  })}
                  <td>
                    {row?.txId ? <Mono value={row.txId} head={8} tail={6} /> : <span className="muted">—</span>}
                    {row?.error && <div className="err-text small">{row.error}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function EventLog({ logs }: { logs: LogLine[] }) {
  return (
    <Panel title="Event log" id="log">
      <div className="log" role="log" aria-live="polite">
        {logs.slice(-150).reverse().map((l, i) => (
          <div key={`${l.at}-${i}`} className={`log-line lv-${l.level}`}>
            <span className="mono muted">{fmtTime(l.at)}</span>
            {l.jobId && <span className="mono">{l.jobId}</span>}
            <span>{l.message}</span>
          </div>
        ))}
        {logs.length === 0 && <div className="muted">Waiting for events…</div>}
      </div>
    </Panel>
  );
}
