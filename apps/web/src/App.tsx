import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CreateJobRequest, WalletView, WsServerMessage } from "@mint-engine/core";
import { ApiClient, ApiError, loadToken, openStream, saveToken } from "./lib/api";
import { initialJobsState, jobsReducer, sortedJobs } from "./lib/store";
import { TokenGate } from "./components/TokenGate";
import { WalletsPanel, type VaultState } from "./components/WalletsPanel";
import { MintForm } from "./components/MintForm";
import { EventLog, JobsList, Timeline } from "./components/JobsPanel";

export interface AppProps {
  /** Override the WebSocket URL (tests). */
  wsUrl?: string;
}

export function App({ wsUrl }: AppProps) {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const [gateError, setGateError] = useState<string | null>(null);
  const client = useMemo(() => (token ? new ApiClient(token) : null), [token]);

  const [vault, setVault] = useState<VaultState>("unknown");
  const [wallets, setWallets] = useState<WalletView[]>([]);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, dispatch] = useReducer(jobsReducer, initialJobsState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const jobsListRef = useRef<HTMLDivElement>(null);

  const disconnect = useCallback((msg: string) => {
    saveToken(null);
    setToken(null);
    setGateError(msg);
    setVault("unknown");
    setWallets([]);
    setConnected(false);
    setSelectedId(null);
    dispatch({ type: "reset" });
  }, []);

  /** Wraps API calls: 401 drops the token and returns to the gate. */
  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        disconnect("Session token rejected by the server.");
        return undefined;
      }
      throw e;
    }
  }, [disconnect]);

  const loadWallets = useCallback(async () => {
    if (!client) return;
    try {
      const ws = await guard(() => client.wallets());
      if (ws) {
        setWallets(ws);
        setVault("unlocked");
        setVaultError(null);
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 423 || e.status === 403)) {
        setVault("locked");
        setWallets([]);
      } else {
        setVaultError((e as Error).message);
      }
    }
  }, [client, guard]);

  const refetchJobs = useCallback(async () => {
    if (!client) return;
    try {
      const jobs = await guard(() => client.jobs());
      if (jobs) dispatch({ type: "replace", jobs });
    } catch (e) {
      setBanner(`Failed to load jobs: ${(e as Error).message}`);
    }
  }, [client, guard]);

  // Initial load + live stream.
  useEffect(() => {
    if (!client || !token) return;
    void loadWallets();
    void refetchJobs();
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    const onMsg = (m: WsServerMessage) => {
      dispatch({ type: "ws", msg: m });
      if (m.type === "event" && "jobId" in m.event && m.event.jobId && !stateRef.current.jobs[m.event.jobId]) {
        // An event for a job created elsewhere (another tab / CLI): fetch its details.
        clearTimeout(refetchTimer);
        refetchTimer = setTimeout(() => void refetchJobs(), 100);
      }
    };
    // A dropped/rejected WS gives no status code, so probe REST: a 401 there returns to the token gate.
    let lastProbe = 0;
    const onDrop = () => {
      if (Date.now() - lastProbe < 4000) return;
      lastProbe = Date.now();
      void refetchJobs();
    };
    const h = openStream(token, onMsg, setConnected, wsUrl, onDrop);
    return () => {
      clearTimeout(refetchTimer);
      h.close();
    };
  }, [client, token, wsUrl, loadWallets, refetchJobs]);

  const unlock = async (passphrase: string) => {
    if (!client) return;
    setVaultBusy(true);
    setVaultError(null);
    try {
      const r = await guard(() => client.unlock(passphrase));
      if (r && !r.ok) setVaultError("Unlock failed");
      else if (r) await loadWallets();
    } catch (e) {
      setVaultError(e instanceof ApiError && e.status === 403 ? "Wrong passphrase" : (e as Error).message);
    } finally {
      setVaultBusy(false);
    }
  };

  const lock = useCallback(async () => {
    if (!client) return;
    setVaultBusy(true);
    try {
      await guard(() => client.lock());
      setVault("locked");
      setWallets([]);
    } catch (e) {
      setVaultError((e as Error).message);
    } finally {
      setVaultBusy(false);
    }
  }, [client, guard]);

  const submit = async (req: CreateJobRequest) => {
    if (!client) throw new Error("not connected");
    const view = await guard(() => client.createJob(req));
    if (!view) throw new Error("not connected");
    dispatch({ type: "upsert", job: view });
    setSelectedId(view.job.id);
  };

  const cancel = async (id: string) => {
    if (!client) return;
    try {
      const view = await guard(() => client.cancelJob(id));
      if (view) dispatch({ type: "upsert", job: view });
    } catch (e) {
      setBanner(`Cancel failed: ${(e as Error).message}`);
    }
  };

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        document.getElementById("mf-chain")?.focus();
      } else if (k === "j") {
        e.preventDefault();
        jobsListRef.current?.focus();
      } else if (k === "l" && vault === "unlocked") {
        e.preventDefault();
        void lock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vault, lock]);

  const jobs = sortedJobs(state);
  const selected = (selectedId && state.jobs[selectedId]) || jobs[0] || null;

  if (!token) {
    return (
      <TokenGate
        error={gateError}
        onSubmit={(t) => {
          saveToken(t);
          setGateError(null);
          setToken(t);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">MINT<span>·</span>ENGINE</div>
        <div className="topbar-status">
          <span className={`dot ${connected ? "on" : "off"}`} aria-hidden />
          <span className="mono">{connected ? "stream live" : "stream offline"}</span>
          <span className="sep" />
          <span className="mono muted">{wallets.length} wallets · {jobs.length} jobs</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => disconnect("Disconnected.")}>Forget token</button>
      </header>
      {banner && (
        <div className="banner" role="alert">
          {banner}
          <button type="button" className="btn-icon" aria-label="Dismiss" onClick={() => setBanner(null)}>×</button>
        </div>
      )}
      <main className="layout">
        <div className="area-wallets">
          <WalletsPanel vault={vault} wallets={wallets} busy={vaultBusy} error={vaultError} onUnlock={unlock} onLock={() => void lock()} onRefresh={() => void loadWallets()} />
        </div>
        <div className="area-form">
          <MintForm wallets={wallets} disabled={vault !== "unlocked"} onSubmit={submit} />
        </div>
        <div className="area-jobs">
          <JobsList ref={jobsListRef} state={state} jobs={jobs} selectedId={selected?.job.id ?? null} onSelect={setSelectedId} onCancel={cancel} />
          <Timeline state={state} view={selected} wallets={wallets} />
          <EventLog logs={state.logs} />
        </div>
      </main>
    </div>
  );
}
