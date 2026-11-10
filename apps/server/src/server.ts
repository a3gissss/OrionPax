// Local dashboard server: REST + WebSocket over node:http, bound to loopback only.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CHAIN_FAMILY, DEFAULT_SERVER_PORT, WS_PATH,
  type CreateJobRequest, type EngineEvent, type WsServerMessage,
} from "@mint-engine/core";
import type { EnginePort, VaultPort } from "./ports.js";
import { createJobSchema, formatIssues, unlockSchema } from "./schemas.js";
import {
  WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX,
  checkRequestOrigin, decodeTokenProtocol, generateToken, tokenFromHeaders, tokenMatches,
} from "./security.js";

export type LoopbackHost = "127.0.0.1" | "::1";

export interface ServerOptions {
  engine: EnginePort;
  vault: VaultPort;
  /** Default DEFAULT_SERVER_PORT; 0 picks a random free port. */
  port?: number;
  /** Loopback only. Default 127.0.0.1. */
  host?: LoopbackHost;
  /** Fixed token (tests). Default: random per run. */
  token?: string;
  /** Directory of the built web app; default apps/web/dist if present. Pass null to disable. */
  staticDir?: string | null;
  /** Request log sink (method, path, status only). Default: silent. */
  log?: (line: string) => void;
  /** Close WS clients that haven't authenticated within this time. Default 5000ms. */
  wsAuthTimeoutMs?: number;
}

export interface DashboardServer {
  readonly token: string;
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  /** Underlying http server (for tests). */
  readonly http: Server;
}

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json",
};

function defaultStaticDir(): string | null {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(join(dir, "index.html")) ? dir : null;
}

export function createServer(opts: ServerOptions): DashboardServer {
  const { engine, vault } = opts;
  const host: LoopbackHost = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("server must bind to a loopback address");
  const token = opts.token ?? generateToken();
  const staticDir = opts.staticDir === undefined ? defaultStaticDir() : opts.staticDir;
  const log = opts.log ?? (() => {});
  const wsAuthTimeoutMs = opts.wsAuthTimeoutMs ?? 5000;

  const authed = new Set<WebSocket>();
  const unsubscribe = engine.on((event: EngineEvent) => broadcast({ type: "event", event }));

  function broadcast(msg: WsServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of authed) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (!origin) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type, x-session-token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    };
  }

  function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
    if (req.headers.connection === "close") res.shouldKeepAlive = false;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
    });
    res.end(JSON.stringify(body));
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = req.headers["content-type"] ?? "";
    if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      // Don't read it; close the connection after replying so the unread body is discarded.
      req.headers.connection = "close";
      throw new HttpError(413, "body too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    // Drain fully (never break out of the iterator: that destroys the socket before we can reply).
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    }
    if (tooLarge) throw new HttpError(413, "body too large");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  function requireUnlocked() {
    if (!vault.isUnlocked()) throw new HttpError(423, "vault is locked");
  }

  async function validateJob(body: unknown): Promise<CreateJobRequest> {
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "invalid job request", formatIssues(parsed.error));
    const req = parsed.data as CreateJobRequest;
    requireUnlocked();
    const wallets = new Map((await vault.list()).map((w) => [w.id, w]));
    const family = CHAIN_FAMILY[req.target.chain];
    for (const id of req.walletIds) {
      const w = wallets.get(id);
      if (!w) throw new HttpError(400, `unknown walletId: ${id}`);
      if (w.family !== family) throw new HttpError(400, `wallet ${id} is ${w.family}, target chain needs ${family}`);
    }
    return req;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, method: string, path: string) {
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (!tokenMatches(token, tokenFromHeaders(req))) throw new HttpError(401, "missing or invalid session token");

    if (method === "GET" && path === "/api/wallets") {
      requireUnlocked();
      return sendJson(req, res, 200, await vault.list());
    }
    if (method === "POST" && path === "/api/vault/unlock") {
      const parsed = unlockSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, "invalid unlock request");
      const ok = await vault.unlock(parsed.data.passphrase);
      if (!ok) throw new HttpError(403, "wrong passphrase");
      return sendJson(req, res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/vault/lock") {
      await vault.lock();
      return sendJson(req, res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/jobs") return sendJson(req, res, 200, engine.list());
    if (method === "POST" && path === "/api/jobs") {
      const jobReq = await validateJob(await readJson(req));
      const view = await engine.createJob(jobReq);
      engine.run(view.job.id).catch((err: unknown) => {
        log(`job ${view.job.id} run error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return sendJson(req, res, 201, view);
    }
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel?.[1]) {
      let id: string;
      try {
        id = decodeURIComponent(cancel[1]);
      } catch {
        throw new HttpError(404, "job not found");
      }
      const view = await engine.cancel(id);
      if (!view) throw new HttpError(404, "job not found");
      return sendJson(req, res, 200, view);
    }
    throw new HttpError(404, "not found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<boolean> {
    if (!staticDir || (method !== "GET" && method !== "HEAD")) return false;
    const root = resolve(staticDir);
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return false;
    }
    let file = resolve(root, "." + rel);
    if (file !== root && !file.startsWith(root + sep)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
    if (!existsSync(file)) return false;
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(method === "HEAD" ? undefined : data);
    return true;
  }

  const http = createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch { /* keep "/" */ }
    res.on("finish", () => log(`${method} ${path} ${res.statusCode}`));
    try {
      if (!checkRequestOrigin(req)) throw new HttpError(403, "forbidden host or origin");
      if (path === "/api" || path.startsWith("/api/")) return await handleApi(req, res, method, path);
      if (await serveStatic(req, res, method, path)) return;
      throw new HttpError(404, "not found");
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) {
        sendJson(req, res, err.status, err.details ? { error: err.message, issues: err.details } : { error: err.message });
      } else {
        log(`internal error on ${method} ${path}: ${err instanceof Error ? err.message : "unknown"}`);
        sendJson(req, res, 500, { error: "internal error" });
      }
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    // Select our protocol when offered; never echo the token-carrying entry.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  function rejectUpgrade(socket: Duplex, status: number, text: string) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function admit(ws: WebSocket) {
    authed.add(ws);
    const snapshot: WsServerMessage = { type: "snapshot", jobs: engine.list() };
    ws.send(JSON.stringify(snapshot));
  }

  http.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (url.pathname !== WS_PATH) return rejectUpgrade(socket, 404, "Not Found");
    if (!checkRequestOrigin(req)) return rejectUpgrade(socket, 403, "Forbidden");
    // Token sources: subprotocol `token.<base64url>` (browsers), `?token=` query, or first message.
    const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const protoEntry = offered.find((p) => p.startsWith(WS_TOKEN_PROTOCOL_PREFIX));
    const protoToken = protoEntry !== undefined ? decodeTokenProtocol(protoEntry) : undefined;
    const queryToken = url.searchParams.get("token");
    const presented = protoEntry !== undefined ? protoToken : queryToken;
    if ((protoEntry !== undefined || queryToken !== null) && !tokenMatches(token, presented)) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("close", () => authed.delete(ws));
      ws.on("error", () => authed.delete(ws));
      if (presented !== null && presented !== undefined) return admit(ws);
      // Otherwise the first message must be {"type":"auth","token":"..."}.
      const timer = setTimeout(() => ws.close(4401, "auth timeout"), wsAuthTimeoutMs);
      ws.once("close", () => clearTimeout(timer));
      ws.once("message", (data: RawData) => {
        clearTimeout(timer);
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch { /* fallthrough */ }
        const m = msg as { type?: unknown; token?: unknown } | undefined;
        if (m?.type === "auth" && typeof m.token === "string" && tokenMatches(token, m.token)) admit(ws);
        else ws.close(4401, "unauthorized");
      });
    });
  });

  return {
    token,
    http,
    listen() {
      return new Promise((resolveListen, reject) => {
        http.once("error", reject);
        http.listen(opts.port ?? DEFAULT_SERVER_PORT, host, () => {
          http.off("error", reject);
          const addr = http.address();
          const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_SERVER_PORT);
          const h = host === "::1" ? "[::1]" : host;
          resolveListen({ port, url: `http://${h}:${port}` });
        });
      });
    },
    close() {
      unsubscribe();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolveClose) => {
        http.closeAllConnections();
        http.close(() => resolveClose());
      });
    },
  };
}
