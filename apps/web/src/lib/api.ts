// Typed client for the dashboard REST API + WebSocket stream (contract: @mint-engine/core api.ts).
import type { ApiRoutes, CreateJobRequest, JobView, WalletView, WsServerMessage } from "@mint-engine/core";
import { WS_PATH } from "@mint-engine/core";

export const TOKEN_HEADER = "x-session-token";
export const TOKEN_STORAGE_KEY = "mint-engine.session-token";
/** WebSocket subprotocol carrying the session token as `token.<base64url(token)>` (browsers cannot set WS headers). */
export const WS_TOKEN_PROTOCOL_PREFIX = "token.";
export const WS_PROTOCOL = "mint-engine";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Route = keyof ApiRoutes;
type ReqOf<R extends Route> = ApiRoutes[R] extends { req: infer Q } ? Q : undefined;
type ResOf<R extends Route> = ApiRoutes[R]["res"];

export function loadToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage unavailable: token lives only in memory */
  }
}

export class ApiClient {
  constructor(readonly token: string, readonly baseUrl = "") {}

  async call<R extends Route>(route: R, body?: ReqOf<R>, params: Record<string, string> = {}): Promise<ResOf<R>> {
    const [method, rawPath] = (route as string).split(" ") as [string, string];
    const path = rawPath.replace(/:(\w+)/g, (_, k: string) => {
      const v = params[k];
      if (v === undefined) throw new Error(`missing route param ${k}`);
      return encodeURIComponent(v);
    });
    const headers: Record<string, string> = { [TOKEN_HEADER]: this.token, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "") || res.statusText || `HTTP ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return data as ResOf<R>;
  }

  wallets(): Promise<WalletView[]> { return this.call("GET /api/wallets"); }
  unlock(passphrase: string) { return this.call("POST /api/vault/unlock", { passphrase }); }
  lock() { return this.call("POST /api/vault/lock"); }
  jobs(): Promise<JobView[]> { return this.call("GET /api/jobs"); }
  createJob(req: CreateJobRequest): Promise<JobView> { return this.call("POST /api/jobs", req); }
  cancelJob(id: string): Promise<JobView> { return this.call("POST /api/jobs/:id/cancel", undefined, { id }); }
}

export interface StreamHandle {
  close(): void;
}

/** base64url (no padding) of the UTF-8 token: always a valid RFC 7230 token for Sec-WebSocket-Protocol. */
export function encodeTokenProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return WS_TOKEN_PROTOCOL_PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeTokenProtocol(protocol: string): string | null {
  if (!protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return null;
  try {
    const b64 = protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Connects to the WS stream, reconnecting with backoff until closed.
 * `onDrop` fires each time a connection attempt ends without a deliberate close
 * (the caller can probe REST to detect a rejected token).
 */
export function openStream(
  token: string,
  onMessage: (m: WsServerMessage) => void,
  onState: (connected: boolean) => void,
  url = defaultWsUrl(),
  onDrop?: () => void,
): StreamHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = () => {
    if (closed) return;
    onDrop?.();
    const delay = Math.min(5000, 250 * 2 ** attempt++);
    timer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (closed) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url, [WS_PROTOCOL, encodeTokenProtocol(token)]);
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (closed || ws !== sock) return;
      attempt = 0;
      onState(true);
    };
    sock.onmessage = (ev) => {
      if (closed || ws !== sock) return;
      try {
        onMessage(JSON.parse(String(ev.data)) as WsServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = () => {
      // Ignore late close events from sockets we already replaced or closed on purpose.
      if (closed || ws !== sock) return;
      onState(false);
      scheduleRetry();
    };
  };
  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

function defaultWsUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${WS_PATH}`;
}
