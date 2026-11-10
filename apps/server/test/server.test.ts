import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { WebSocket } from "ws";
import type { JobView, WsServerMessage } from "@mint-engine/core";
import { createServer, type DashboardServer } from "../src/server.js";
import { DEV_PASSPHRASE, FakeEngine, FakeVault } from "../src/dev-fakes.js";
import { decodeTokenProtocol, encodeTokenProtocol, isAllowedOrigin, isLoopbackHost } from "../src/security.js";

const job = (walletIds: string[], extra: Record<string, unknown> = {}) => ({
  target: { kind: "nft", chain: "base", address: "0xabc", quantity: 1 },
  walletIds,
  fees: { priorityFee: "1000" },
  trigger: { type: "now" },
  ...extra,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`);

let server: DashboardServer;
let base: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  const vault = new FakeVault();
  server = createServer({
    engine: new FakeEngine({ stepDelayMs: 5, wallets: vault.refs() }), vault,
    port: 0, staticDir: null, log: (l) => logs.push(l),
  });
  base = (await server.listen()).url;
});
afterEach(() => server.close());

function api(path: string, init: RequestInit = {}, token: string | null = server.token) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(base + path, { ...init, headers });
}
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const unlock = () => post("/api/vault/unlock", { passphrase: DEV_PASSPHRASE });

/** Raw request so we can forge the Host header (fetch forbids it). */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("security", () => {
  it("host/origin helpers", () => {
    expect(isLoopbackHost("localhost:4810")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]:4810")).toBe(true);
    expect(isLoopbackHost("evil.example:4810")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("file://")).toBe(false);
    const t = "ab".repeat(32);
    expect(decodeTokenProtocol(encodeTokenProtocol(t))).toBe(t);
    // Matches apps/web encodeTokenProtocol (btoa, base64url, no padding).
    expect(encodeTokenProtocol("hi?")).toBe("token.aGk_");
    expect(decodeTokenProtocol("token.***")).toBeNull();
  });

  it("requires the session token", async () => {
    expect((await api("/api/jobs", {}, null)).status).toBe(401);
    expect((await api("/api/jobs", {}, "nope")).status).toBe(401);
    const x = await fetch(base + "/api/jobs", { headers: { "x-session-token": server.token } });
    expect(x.status).toBe(200);
  });

  it("rejects foreign Host (DNS rebinding) and Origin", async () => {
    const auth = { authorization: `Bearer ${server.token}` };
    expect(await rawGet("/api/jobs", { ...auth, host: "evil.example" })).toBe(403);
    expect(await rawGet("/api/jobs", { ...auth, host: "localhost" })).toBe(200);
    expect((await api("/api/jobs", { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await api("/api/jobs", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("refuses non-loopback bind", () => {
    expect(() => createServer({ engine: new FakeEngine(), vault: new FakeVault(), host: "0.0.0.0" as never })).toThrow();
  });

  it("never logs or echoes the passphrase", async () => {
    const secret = "super-secret-pass-123";
    const res = await post("/api/vault/unlock", { passphrase: secret });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong passphrase" });
    const bad = await post("/api/vault/unlock", { passphrase: secret, extra: 1 });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
  });
});

describe("REST", () => {
  it("wallets need an unlocked vault", async () => {
    expect((await api("/api/wallets")).status).toBe(423);
    expect(await (await unlock()).json()).toEqual({ ok: true });
    const wallets = await (await api("/api/wallets")).json();
    expect(wallets).toHaveLength(10);
    await post("/api/vault/lock");
    expect((await api("/api/wallets")).status).toBe(423);
  });

  it("wrong passphrase does not re-lock an unlocked vault", async () => {
    await unlock();
    expect((await post("/api/vault/unlock", { passphrase: "typo" })).status).toBe(403);
    expect((await api("/api/wallets")).status).toBe(200);
  });

  it("job creation needs an unlocked vault", async () => {
    expect((await post("/api/jobs", job(["w1"]))).status).toBe(423);
  });

  it("oversized body -> 413 with a JSON error", async () => {
    await unlock();
    const res = await post("/api/jobs", { ...job(["w1"]), pad: "x".repeat(100 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
  });

  it("malformed job id escape -> 404", async () => {
    expect((await post("/api/jobs/%E0%A4%A/cancel")).status).toBe(404);
  });

  it("cancel during a far-future time trigger stays cancelled", async () => {
    await unlock();
    const res = await post("/api/jobs", job(["w1"], { trigger: { type: "time", at: Date.now() + 40 * 86_400_000 } }));
    const view = (await res.json()) as JobView;
    await new Promise((r) => setTimeout(r, 30));
    let list = (await (await api("/api/jobs")).json()) as JobView[];
    expect(list[0]?.status).toBe("waiting");
    await post(`/api/jobs/${view.job.id}/cancel`);
    await new Promise((r) => setTimeout(r, 30));
    list = (await (await api("/api/jobs")).json()) as JobView[];
    expect(list[0]?.status).toBe("cancelled");
  });

  it("validates job bodies", async () => {
    await unlock();
    expect((await post("/api/jobs", job([]))).status).toBe(400);
    expect((await post("/api/jobs", job([...ids(10), "w11"]))).status).toBe(400);
    expect((await post("/api/jobs", job(["w1", "w1"]))).status).toBe(400);
    expect((await post("/api/jobs", job(["w99"]))).status).toBe(400);
    expect((await post("/api/jobs", job(["w1"], { target: { kind: "nft", chain: "solana", address: "x", quantity: 1 } }))).status).toBe(400);
    expect((await post("/api/jobs", job(["w1"], { fees: { priorityFee: "-1" } }))).status).toBe(400);
    expect((await post("/api/jobs", job(["w1"], { trigger: { type: "soon" } }))).status).toBe(400);
    const r = await api("/api/jobs", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
  });

  it("creates, lists and cancels jobs", async () => {
    await unlock();
    const res = await post("/api/jobs", job(ids(3), { trigger: { type: "time", at: Date.now() + 60_000 } }));
    expect(res.status).toBe(201);
    const view = (await res.json()) as JobView;
    expect(view.job.walletIds).toEqual(ids(3));
    const list = (await (await api("/api/jobs")).json()) as JobView[];
    expect(list.map((j) => j.job.id)).toEqual([view.job.id]);
    const c = await post(`/api/jobs/${view.job.id}/cancel`);
    expect(((await c.json()) as JobView).status).toBe("cancelled");
    expect((await post("/api/jobs/nope/cancel")).status).toBe(404);
  });

  it("token launch target is accepted", async () => {
    await unlock();
    const res = await post("/api/jobs", job(["w1"], {
      target: { kind: "token", chain: "base", tokenAddress: "0x1", launchpadAddress: "0x2", spendPerWallet: "1000", slippageBps: 500 },
    }));
    expect(res.status).toBe(201);
  });
});

describe("WebSocket", () => {
  function collect(ws: WebSocket, until: (m: WsServerMessage[]) => boolean): Promise<WsServerMessage[]> {
    const msgs: WsServerMessage[] = [];
    return new Promise((resolve, reject) => {
      ws.on("message", (d) => {
        msgs.push(JSON.parse(d.toString()));
        if (until(msgs)) resolve(msgs);
      });
      ws.on("close", (code) => reject(new Error(`closed ${code}`)));
      ws.on("error", reject);
    });
  }
  const wsUrl = () => base.replace("http", "ws") + "/ws";

  it("snapshot then events (query token)", async () => {
    await unlock();
    const ws = new WebSocket(`${wsUrl()}?token=${server.token}`);
    const first = await collect(ws, (m) => m.length >= 1);
    expect(first[0]).toEqual({ type: "snapshot", jobs: [] });
    const done = collect(ws, (m) => m.some((x) => x.type === "event" && x.event.type === "job.status" && x.event.status === "done"));
    await post("/api/jobs", job(ids(2)));
    const msgs = await done;
    const confirmed = msgs.filter((m) => m.type === "event" && m.event.type === "tx.status" && m.event.status === "confirmed");
    expect(confirmed).toHaveLength(2);
    ws.close();
  });

  it("auth via subprotocol (apps/web contract)", async () => {
    const ws = new WebSocket(wsUrl(), ["mint-engine", encodeTokenProtocol(server.token)]);
    const p = collect(ws, (m) => m.length >= 1);
    expect((await p)[0]?.type).toBe("snapshot");
    expect(ws.protocol).toBe("mint-engine");
    ws.close();
    const status = await new Promise<number>((resolve) => {
      const bad = new WebSocket(wsUrl(), ["mint-engine", encodeTokenProtocol("wrong")]);
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      bad.on("open", () => { bad.close(); resolve(101); });
      bad.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("auth via first message", async () => {
    const ws = new WebSocket(wsUrl());
    const p = collect(ws, (m) => m.length >= 1);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: server.token })));
    expect((await p)[0]?.type).toBe("snapshot");
    ws.close();
  });

  it("rejects bad token and foreign origin", async () => {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl());
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "bad" })));
      ws.on("close", (code) => resolve(code));
    });
    expect(closed).toBe(4401);
    const status = (url: string, origin?: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(url, origin ? { origin } : {});
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("error", () => {});
    });
    expect(await status(`${wsUrl()}?token=bad`)).toBe(401);
    expect(await status(`${wsUrl()}?token=${server.token}`, "http://evil.example")).toBe(403);
  });
});
