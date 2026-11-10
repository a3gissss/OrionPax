// Tiny local JSON-RPC server for tests (supports batches). Binds to 127.0.0.1 only.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export class StubRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export type Handler = (method: string, params: unknown[]) => unknown | Promise<unknown>;

export interface StubRpc {
  url: string;
  calls: Array<{ method: string; params: unknown[] }>;
  close(): Promise<void>;
}

export async function startStubRpc(handler: Handler): Promise<StubRpc> {
  const calls: StubRpc["calls"] = [];
  const answer = async (req: { id?: unknown; method?: string; params?: unknown[] }) => {
    const method = req.method ?? "";
    const params = req.params ?? [];
    calls.push({ method, params });
    try {
      return { jsonrpc: "2.0", id: req.id ?? null, result: (await handler(method, params)) ?? null };
    } catch (e) {
      const code = e instanceof StubRpcError ? e.code : -32000;
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(answer)) : await answer(parsed as never);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const methodNotFound = (m: string) => new StubRpcError(-32601, `the method ${m} does not exist/is not available`);
