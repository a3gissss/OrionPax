// E2E: spawns the real dev entrypoint (dist/main.js, fakes) on a random port and drives it over HTTP + WS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { JobView, WalletView, WsServerMessage } from "@mint-engine/core";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let child: ChildProcess;
let port = 0;
let token = "";
let stdout = "";
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  child = spawn(process.execPath, [MAIN, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}`)), 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
      const p = /MINT_ENGINE_PORT=(\d+)/.exec(stdout);
      const t = /MINT_ENGINE_TOKEN=([0-9a-f]{64})/.exec(stdout);
      if (p && t) {
        port = Number(p[1]);
        token = t[1]!;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${stdout}`)));
  });
});

afterAll(() => { child?.kill(); });

// Same transport as apps/web: x-session-token header + WS subprotocols.
const auth = () => ({ "x-session-token": token, "content-type": "application/json" });

describe("dashboard server e2e", () => {
  it("unlock, list 10 wallets, run a 10-wallet job with WS stream", async () => {
    const unlock = await fetch(`${base()}/api/vault/unlock`, {
      method: "POST", headers: auth(), body: JSON.stringify({ passphrase: "dev-passphrase" }),
    });
    expect(await unlock.json()).toEqual({ ok: true });

    const wallets = (await (await fetch(`${base()}/api/wallets`, { headers: auth() })).json()) as WalletView[];
    expect(wallets).toHaveLength(10);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["mint-engine", "token." + Buffer.from(token).toString("base64url")]);
    const msgs: WsServerMessage[] = [];
    let onMsg = () => {};
    ws.on("message", (d) => { msgs.push(JSON.parse(d.toString())); onMsg(); });
    const waitFor = (pred: () => boolean) => new Promise<void>((resolve) => {
      onMsg = () => { if (pred()) resolve(); };
      onMsg();
    });
    await waitFor(() => msgs.length >= 1);
    expect(msgs[0]?.type).toBe("snapshot");

    const res = await fetch(`${base()}/api/jobs`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({
        target: { kind: "nft", chain: "base", address: "0x00000000000000000000000000000000000000aa", quantity: 1 },
        walletIds: wallets.map((w) => w.id),
        fees: { priorityFee: "1000000", privateSubmission: false },
        trigger: { type: "now" },
      }),
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as JobView;

    const confirmed = () => msgs.filter((m) => m.type === "event" && m.event.type === "tx.status"
      && m.event.jobId === view.job.id && m.event.status === "confirmed");
    await waitFor(() => confirmed().length >= 10);
    expect(new Set(confirmed().map((m) => m.type === "event" && m.event.type === "tx.status" ? m.event.walletId : "")).size).toBe(10);
    ws.close();

    // Give the engine a moment to flip to done, then check GET /api/jobs.
    let jobs: JobView[] = [];
    for (let i = 0; i < 50; i++) {
      jobs = (await (await fetch(`${base()}/api/jobs`, { headers: auth() })).json()) as JobView[];
      if (jobs[0]?.status === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("done");
    expect(jobs[0]?.outcomes.filter((o) => o.status === "confirmed")).toHaveLength(10);
  });

  it("missing token -> 401", async () => {
    expect((await fetch(`${base()}/api/wallets`)).status).toBe(401);
  });

  it("evil Origin -> 403", async () => {
    const r = await fetch(`${base()}/api/wallets`, { headers: { ...auth(), origin: "http://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("11 wallets -> 400", async () => {
    const r = await fetch(`${base()}/api/jobs`, {
      method: "POST", headers: auth(),
      body: JSON.stringify({
        target: { kind: "nft", chain: "base", address: "0xaa", quantity: 1 },
        walletIds: Array.from({ length: 11 }, (_, i) => `w${i + 1}`),
        fees: {}, trigger: { type: "now" },
      }),
    });
    expect(r.status).toBe(400);
  });

  it("not reachable on non-loopback interfaces", async () => {
    const addrs = Object.values(networkInterfaces()).flat()
      .filter((a) => a && !a.internal && a.family === "IPv4").map((a) => a!.address);
    for (const host of addrs) {
      const reachable = await new Promise<boolean>((resolve) => {
        const s = connect({ host, port, timeout: 1500 });
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
        s.on("timeout", () => { s.destroy(); resolve(false); });
      });
      expect(reachable, `reachable on ${host}`).toBe(false);
    }
    expect(stdout).not.toMatch(/dev-passphrase.*unlock/);
  });
});
