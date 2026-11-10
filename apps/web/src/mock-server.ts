// Vite plugin that serves a fake dashboard API (/api/*) and WS stream (/ws) in-process.
// Enabled by `npm run dev:mock -w @mint-engine/web` (vite --mode mock). Token: MOCK_TOKEN.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";
import { WS_PATH } from "@mint-engine/core";
import { MockBackend, MOCK_TOKEN } from "./mock/backend";
import { TOKEN_HEADER, WS_PROTOCOL, decodeTokenProtocol } from "./lib/api";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function tokenFromProtocols(header: string | undefined): string | null {
  const parts = (header ?? "").split(",").map((s) => s.trim());
  for (const p of parts) {
    const t = decodeTokenProtocol(p);
    if (t !== null) return t;
  }
  return null;
}

export function mockServerPlugin(): Plugin {
  return {
    name: "mint-engine-mock-server",
    apply: "serve",
    configureServer(server) {
      const backend = new MockBackend();
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const raw = req.headers[TOKEN_HEADER];
        const token = Array.isArray(raw) ? raw[0] : raw;
        const out = backend.handle(req.method ?? "GET", url, token, body);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.body ?? null));
      });

      server.httpServer?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== WS_PATH) return; // leave Vite HMR upgrades alone
        if (!backend.checkToken(tokenFromProtocols(req.headers["sec-websocket-protocol"]))) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const off = backend.subscribe((m) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
          });
          ws.on("close", off);
        });
      });

      server.httpServer?.once("listening", () => {
        server.config.logger.info(`\n  [mock] dashboard API + WS stream active. Session token: ${MOCK_TOKEN}\n  [mock] any passphrase unlocks the vault (except "wrong")\n`);
      });
      server.httpServer?.on("close", () => {
        backend.dispose();
        wss.close();
      });
    },
  };
}
