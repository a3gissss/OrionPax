// In-memory fake of the dashboard server (REST + event stream). Runtime-agnostic: used by the
// Vite mock middleware (src/mock-server.ts) in dev and directly by component tests.
import {
  MAX_WALLETS_PER_JOB, CHAIN_FAMILY,
  type CreateJobRequest, type EngineEvent, type JobStatus, type JobView, type TxOutcome, type TxStatus,
  type WalletView, type WsServerMessage,
} from "@mint-engine/core";

export const MOCK_TOKEN = "mock-session-token";

export interface MockResponse {
  status: number;
  body: unknown;
}

export interface MockBackendOptions {
  /** Multiplier on all simulated delays (0 = as fast as timers allow). */
  speed?: number;
  /** Start unlocked (handy for tests). */
  unlocked?: boolean;
  /** Deterministic RNG seed. */
  seed?: number;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function mockWalletViews(rand = rng(7)): WalletView[] {
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const b58 = (n: number) => Array.from({ length: n }, () => B58[Math.floor(rand() * 58)]).join("");
  const wei = () => String(BigInt(Math.floor(rand() * 2_000_000)) * 10n ** 12n);
  const lamports = () => String(Math.floor(rand() * 40_000_000_000));
  const evm: WalletView[] = Array.from({ length: 12 }, (_, i) => ({
    id: `evm-${i + 1}`, label: `EVM ${String(i + 1).padStart(2, "0")}`, family: "evm",
    address: `0x${hex(40)}`,
    balances: { ethereum: wei(), base: wei(), robinhood: wei() },
  }));
  const sol: WalletView[] = Array.from({ length: 4 }, (_, i) => ({
    id: `sol-${i + 1}`, label: `SOL ${String(i + 1).padStart(2, "0")}`, family: "solana",
    address: b58(44),
    balances: { solana: lamports() },
  }));
  return [...evm, ...sol];
}

type Listener = (m: WsServerMessage) => void;

export class MockBackend {
  private unlocked: boolean;
  private readonly wallets: WalletView[];
  private readonly jobs = new Map<string, JobView>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private readonly listeners = new Set<Listener>();
  private readonly rand: () => number;
  private readonly speed: number;
  private seq = 0;

  constructor(opts: MockBackendOptions = {}) {
    this.unlocked = opts.unlocked ?? false;
    this.speed = opts.speed ?? 1;
    this.rand = rng(opts.seed ?? 42);
    this.wallets = mockWalletViews();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ type: "snapshot", jobs: this.listJobs() });
    return () => this.listeners.delete(fn);
  }

  checkToken(token: string | null | undefined): boolean {
    return token === MOCK_TOKEN;
  }

  handle(method: string, path: string, token: string | null | undefined, body: unknown): MockResponse {
    if (!this.checkToken(token)) return { status: 401, body: { error: "invalid session token" } };
    const route = `${method.toUpperCase()} ${path.split("?")[0]}`;
    if (route === "POST /api/vault/unlock") {
      const pass = (body as { passphrase?: unknown } | null)?.passphrase;
      if (typeof pass !== "string" || pass.length === 0) return { status: 400, body: { error: "passphrase required" } };
      if (pass === "wrong") return { status: 403, body: { ok: false, error: "bad passphrase" } };
      this.unlocked = true;
      this.log("info", "vault unlocked");
      return { status: 200, body: { ok: true } };
    }
    if (route === "POST /api/vault/lock") {
      this.unlocked = false;
      this.log("info", "vault locked");
      return { status: 200, body: { ok: true } };
    }
    if (route === "GET /api/wallets") {
      if (!this.unlocked) return { status: 423, body: { error: "vault locked" } };
      return { status: 200, body: this.wallets };
    }
    if (route === "GET /api/jobs") return { status: 200, body: this.listJobs() };
    if (route === "POST /api/jobs") {
      if (!this.unlocked) return { status: 423, body: { error: "vault locked" } };
      const err = this.validate(body as CreateJobRequest);
      if (err) return { status: 400, body: { error: err } };
      return { status: 200, body: this.createJob(body as CreateJobRequest) };
    }
    const cancel = /^POST \/api\/jobs\/([^/]+)\/cancel$/.exec(route);
    if (cancel) {
      const id = decodeURIComponent(cancel[1]!);
      const v = this.jobs.get(id);
      if (!v) return { status: 404, body: { error: "no such job" } };
      if (["pending", "waiting", "firing"].includes(v.status)) {
        this.clearTimers(id);
        this.setStatus(id, "cancelled", "cancelled by user");
      }
      return { status: 200, body: this.jobs.get(id) };
    }
    return { status: 404, body: { error: `no route ${route}` } };
  }

  dispose(): void {
    for (const id of this.timers.keys()) this.clearTimers(id);
    this.listeners.clear();
  }

  private listJobs(): JobView[] {
    return [...this.jobs.values()].map((v) => structuredClone(v));
  }

  private validate(req: CreateJobRequest | null): string | null {
    if (!req || typeof req !== "object" || !req.target || !Array.isArray(req.walletIds)) return "malformed request";
    if (req.walletIds.length < 1 || req.walletIds.length > MAX_WALLETS_PER_JOB) return `1..${MAX_WALLETS_PER_JOB} wallets required`;
    const fam = CHAIN_FAMILY[req.target.chain];
    if (!fam) return "unknown chain";
    for (const id of req.walletIds) {
      const w = this.wallets.find((x) => x.id === id);
      if (!w) return `unknown wallet ${id}`;
      if (w.family !== fam) return `wallet ${id} is ${w.family}, chain needs ${fam}`;
    }
    return null;
  }

  private emit(event: EngineEvent): void {
    const msg: WsServerMessage = { type: "event", event };
    for (const l of this.listeners) l(msg);
  }

  private log(level: "info" | "warn" | "error", message: string, jobId?: string): void {
    this.emit({ type: "log", level, message, jobId, at: Date.now() });
  }

  private later(jobId: string, ms: number, fn: () => void): void {
    const t = setTimeout(fn, Math.max(0, ms * this.speed));
    const list = this.timers.get(jobId) ?? [];
    list.push(t);
    this.timers.set(jobId, list);
  }

  private clearTimers(jobId: string): void {
    for (const t of this.timers.get(jobId) ?? []) clearTimeout(t);
    this.timers.delete(jobId);
  }

  private setStatus(jobId: string, status: JobStatus, detail?: string): void {
    const v = this.jobs.get(jobId);
    if (!v) return;
    v.status = status;
    this.emit({ type: "job.status", jobId, status, at: Date.now(), detail });
  }

  private txId(chain: string): string {
    if (chain === "solana") return Array.from({ length: 88 }, () => B58[Math.floor(this.rand() * 58)]).join("");
    return "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(this.rand() * 16)]).join("");
  }

  private createJob(req: CreateJobRequest): JobView {
    const id = `job_${(++this.seq).toString().padStart(4, "0")}`;
    const view: JobView = {
      job: {
        id, target: req.target, walletIds: [...req.walletIds], fees: req.fees, trigger: req.trigger,
        maxRetries: req.maxRetries ?? 2, createdAt: Date.now(),
      },
      status: "pending",
      outcomes: [],
    };
    this.jobs.set(id, view);
    // Emit after the HTTP response is produced so the client knows the job first.
    this.later(id, 0, () => {
      this.emit({ type: "job.created", jobId: id, at: Date.now() });
      this.run(view);
    });
    return structuredClone(view);
  }

  private run(view: JobView): void {
    const id = view.job.id;
    const tr = view.job.trigger;
    let wait = 0;
    let detail = "trigger: now";
    if (tr.type === "time") {
      wait = Math.min(Math.max(0, tr.at - Date.now()), 8000);
      detail = `waiting until ${new Date(tr.at).toISOString()} (mock caps wait at 8s)`;
    } else if (tr.type === "state-poll") { wait = 1500; detail = `polling every ${tr.intervalMs}ms`; }
    else if (tr.type === "event") { wait = 1500; detail = `listening for ${tr.signature ?? "mint-open event"}`; }
    else if (tr.type === "slot-or-block") { wait = 1500; detail = `waiting for block/slot ${tr.at}`; }
    this.setStatus(id, "waiting", detail);
    this.emit({ type: "mint.state", jobId: id, at: Date.now(), state: { live: wait === 0, pricePerUnit: "0", maxPerWallet: 5, remainingSupply: 5000 } });
    this.later(id, wait + 300, () => {
      this.emit({ type: "mint.state", jobId: id, at: Date.now(), state: { live: true, pricePerUnit: "0", maxPerWallet: 5, remainingSupply: 4990 } });
      this.setStatus(id, "firing", "mint live — firing");
      this.log("info", `firing ${view.job.walletIds.length} wallets on ${view.job.target.chain}`, id);
      this.fire(view);
    });
  }

  private fire(view: JobView): void {
    const id = view.job.id;
    const chain = view.job.target.chain;
    // Mock failure rule: NFT quantity above the mock per-wallet limit (5) fails every wallet.
    const overLimit = view.job.target.kind === "nft" && view.job.target.quantity > 5;
    let remaining = view.job.walletIds.length;
    let failed = 0;
    view.job.walletIds.forEach((walletId, i) => {
      const txId = this.txId(chain);
      const steps: TxStatus[] = overLimit
        ? ["prepared", "signed", "sent", "failed"]
        : ["prepared", "signed", "sent", "preconfirmed", "confirmed"];
      let t = i * 25;
      for (const st of steps) {
        t += st === "confirmed" ? 400 + this.rand() * 900 : st === "preconfirmed" ? 150 + this.rand() * 250 : 30 + this.rand() * 80;
        this.later(id, t, () => {
          const at = Date.now();
          const hasId = st !== "prepared" && st !== "signed";
          const error = st === "failed" ? "execution reverted: exceeds max per wallet" : undefined;
          this.emit({ type: "tx.status", jobId: id, walletId, status: st, txId: hasId ? txId : undefined, at, error });
          if (st === "sent") {
            const outcome: TxOutcome = { sent: { chain, walletId, id: txId, sentAt: at, via: ["mock-rpc-1", "mock-rpc-2"] }, status: "sent" };
            view.outcomes.push(outcome);
          }
          const o = view.outcomes.find((x) => x.sent.walletId === walletId);
          if (o && st !== "sent") {
            o.status = st;
            if (st === "confirmed") { o.confirmedAt = at; o.slotOrBlock = 1_000_000 + Math.floor(this.rand() * 1000); }
            if (error) o.error = error;
          }
          if (st === "confirmed" || st === "failed") {
            if (st === "failed") failed++;
            if (--remaining === 0) {
              this.setStatus(id, failed === view.job.walletIds.length ? "failed" : "done", `${view.job.walletIds.length - failed}/${view.job.walletIds.length} confirmed`);
              this.clearTimers(id);
            }
          }
        });
      }
    });
  }
}
