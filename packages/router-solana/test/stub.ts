// Local HTTP stubs: a JSON-RPC server that mimics the Solana methods the router uses,
// and a Jito block-engine endpoint that records calls. Bound to 127.0.0.1 only.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getBase58Decoder, getBase64Encoder } from "@solana/kit";

export interface RpcCall {
  method: string;
  params: unknown[];
}

export interface StubStatus {
  slot: number;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

export class StubServer {
  calls: RpcCall[] = [];
  jitoCalls: Array<{ path: string } & RpcCall> = [];
  height = 1000;
  slot = 5000;
  blockhash = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
  statuses = new Map<string, StubStatus>();
  /** Count of sendTransaction receipts per signature. */
  receipts = new Map<string, number>();
  /** A signature is confirmed once received this many times (default 1). Infinity = never lands. */
  landAfter = new Map<string, number>();
  prioritizationFees: number[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        const path = req.url ?? "/";
        let result: unknown;
        try {
          result = path.startsWith("/api/v1/") ? this.jito(path, msg) : this.handle(msg);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: (e as Error).message } }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private jito(path: string, msg: { method: string; params: unknown[] }): unknown {
    this.jitoCalls.push({ path, method: msg.method, params: msg.params });
    return msg.method === "sendBundle" ? "bundle-id-1" : "jito-sig";
  }

  private handle(msg: { method: string; params: unknown[] }): unknown {
    this.calls.push({ method: msg.method, params: msg.params });
    const ctx = { slot: this.slot, apiVersion: "1.18.26" };
    switch (msg.method) {
      case "sendTransaction": {
        const bytes = new Uint8Array(getBase64Encoder().encode(msg.params[0] as string));
        const sig = getBase58Decoder().decode(bytes.slice(1, 65));
        const n = (this.receipts.get(sig) ?? 0) + 1;
        this.receipts.set(sig, n);
        if (n >= (this.landAfter.get(sig) ?? 1) && !this.statuses.has(sig)) {
          this.statuses.set(sig, { slot: this.slot, err: null, confirmationStatus: "confirmed" });
        }
        return sig;
      }
      case "getSignatureStatuses":
        return {
          context: ctx,
          value: (msg.params[0] as string[]).map((s) => {
            const st = this.statuses.get(s);
            return st ? { slot: st.slot, confirmations: 0, err: st.err, status: st.err ? { Err: st.err } : { Ok: null }, confirmationStatus: st.confirmationStatus } : null;
          }),
        };
      case "getBlockHeight":
        return this.height;
      case "getLatestBlockhash":
        return { context: ctx, value: { blockhash: this.blockhash, lastValidBlockHeight: this.height + 150 } };
      case "isBlockhashValid":
        return { context: ctx, value: true };
      case "getRecentPrioritizationFees":
        return this.prioritizationFees.map((f, i) => ({ slot: this.slot - i, prioritizationFee: f }));
      default:
        throw new Error(`stub: unsupported method ${msg.method}`);
    }
  }
}
