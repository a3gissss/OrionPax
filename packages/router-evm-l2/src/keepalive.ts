// KeepAliveTransport: a JSON-RPC client tuned for low send latency on L2 sequencers.
//
// - HTTP goes through a dedicated undici Agent with keep-alive, so each send reuses
//   an already-open TCP+TLS connection (no handshake on the hot path).
// - `warm()` pre-opens `connections` sockets ahead of the mint so the first
//   `eth_sendRawTransaction` doesn't pay for connection setup.
// - An optional WebSocket can carry requests instead of HTTP once it is open.
// - `viemTransport()` exposes the same pooled connection to viem clients.

import { Agent, request as undiciRequest, WebSocket } from "undici";
import { custom, type CustomTransport } from "viem";

export interface KeepAliveOptions {
  /** HTTP(S) JSON-RPC endpoint. */
  url: string;
  /** Optional WS JSON-RPC endpoint. Used for requests once connected, if `preferWs`. */
  wsUrl?: string;
  /** Use the WS (when open) instead of HTTP for requests. Default true when wsUrl is set. */
  preferWs?: boolean;
  /** Sockets to keep open (and pre-warm). Default 4. */
  connections?: number;
  /** How long idle sockets stay open. Default 60 s. */
  keepAliveTimeoutMs?: number;
  /** Per-request timeout. Default 5 s. */
  timeoutMs?: number;
  /** Extra HTTP headers (for example an auth header). Never logged. */
  headers?: Record<string, string>;
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** Thrown by `batch()` when the server does not support JSON-RPC batches. */
export class BatchUnsupportedError extends RpcError {
  constructor() {
    super("batch not supported");
    this.name = "BatchUnsupportedError";
  }
}

export interface RpcCall {
  method: string;
  params?: unknown[];
}

export type RpcResult<T = unknown> = { ok: true; result: T } | { ok: false; error: RpcError };

/** Minimal surface other modules depend on (handy for fakes in tests). */
export interface RpcClient {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  batch?(calls: RpcCall[]): Promise<RpcResult[]>;
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Host part of an RPC URL, safe to show in the dashboard (drops paths/queries that may carry API keys). */
export function redactUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function toResult(r: JsonRpcResponse | undefined): RpcResult {
  if (!r) return { ok: false, error: new RpcError("missing response") };
  if (r.error) return { ok: false, error: new RpcError(r.error.message ?? "rpc error", r.error.code, r.error.data) };
  return { ok: true, result: r.result };
}

export class KeepAliveTransport implements RpcClient {
  readonly url: string;
  /** Redacted label for this endpoint. */
  readonly label: string;
  private readonly agent: Agent;
  private readonly timeoutMs: number;
  private readonly connections: number;
  private readonly headers: Record<string, string>;
  private readonly preferWs: boolean;
  private idSeq = 1;
  private ws?: WsRpc;

  constructor(private readonly opts: KeepAliveOptions) {
    this.url = opts.url;
    this.label = redactUrl(opts.url);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.connections = Math.max(1, opts.connections ?? 4);
    this.preferWs = opts.preferWs ?? opts.wsUrl !== undefined;
    this.headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    const keepAlive = opts.keepAliveTimeoutMs ?? 60_000;
    this.agent = new Agent({
      connections: this.connections,
      keepAliveTimeout: keepAlive,
      keepAliveMaxTimeout: keepAlive,
      pipelining: 1,
      connect: { timeout: this.timeoutMs },
    });
  }

  /** True when requests currently go over the WebSocket. */
  get usingWs(): boolean {
    return this.preferWs && this.ws?.isOpen === true;
  }

  /**
   * Pre-open the HTTP sockets (one cheap `eth_chainId` per socket, concurrently)
   * and connect the WS if configured. Errors are swallowed: warming is best-effort.
   */
  async warm(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < this.connections; i++) {
      tasks.push(this.httpPost({ jsonrpc: "2.0", id: this.idSeq++, method: "eth_chainId", params: [] }).catch(() => undefined));
    }
    if (this.opts.wsUrl && !this.ws?.isOpen) {
      this.ws?.close();
      const ws = new WsRpc(this.opts.wsUrl, this.timeoutMs);
      this.ws = ws;
      tasks.push(ws.connect().catch(() => { if (this.ws === ws) this.ws = undefined; }));
    }
    await Promise.all(tasks);
  }

  async request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (this.usingWs) {
      try {
        return (await this.ws!.request(method, params)) as T;
      } catch (e) {
        // A JSON-RPC error from the node is a real answer; anything else (closed
        // socket, timeout) falls back to the pooled HTTP connection.
        if (e instanceof RpcError && e.code !== undefined) throw e;
      }
    }
    const body = { jsonrpc: "2.0", id: this.idSeq++, method, params };
    const res = toResult((await this.httpPost(body)) as JsonRpcResponse);
    if (!res.ok) throw res.error;
    return res.result as T;
  }

  /** One HTTP round trip for many calls (JSON-RPC batch). Results keep call order. */
  async batch(calls: RpcCall[]): Promise<RpcResult[]> {
    if (calls.length === 0) return [];
    const base = this.idSeq;
    this.idSeq += calls.length;
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.method, params: c.params ?? [] }));
    const raw = await this.httpPost(body);
    if (!Array.isArray(raw)) {
      // Some servers reply to a batch with a single error object.
      throw new BatchUnsupportedError();
    }
    const byId = new Map<unknown, JsonRpcResponse>();
    for (const r of raw as JsonRpcResponse[]) byId.set(r.id, r);
    return calls.map((_, i) => toResult(byId.get(base + i)));
  }

  /** A viem transport that shares this pooled connection. */
  viemTransport(): CustomTransport {
    return custom({ request: ({ method, params }) => this.request(method, (params as unknown[] | undefined) ?? []) });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = undefined;
    await this.agent.close();
  }

  private async httpPost(body: unknown): Promise<unknown> {
    const res = await undiciRequest(this.url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: this.headers,
      dispatcher: this.agent,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400 && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      throw new RpcError(`HTTP ${res.statusCode}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RpcError(`invalid JSON response (HTTP ${res.statusCode})`);
    }
  }
}

/** Minimal JSON-RPC-over-WebSocket client with id-matched responses. */
class WsRpc {
  private socket?: WebSocket;
  private idSeq = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      const timer = setTimeout(() => { reject(new RpcError("ws connect timeout")); socket.close(); }, this.timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new RpcError("ws error")); });
      socket.addEventListener("close", () => this.failAll(new RpcError("ws closed")));
      socket.addEventListener("message", (ev) => this.onMessage(ev.data));
    });
  }

  request(method: string, params: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError("ws not open"));
    const id = this.idSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`ws timeout: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.failAll(new RpcError("ws closed"));
    this.socket?.close();
    this.socket = undefined;
  }

  private onMessage(data: unknown): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // subscriptions etc.
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const r = toResult(msg);
    if (r.ok) p.resolve(r.result);
    else p.reject(r.error);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
