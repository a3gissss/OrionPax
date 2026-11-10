// Arbitrum Timeboost detection and express-lane submission (Robinhood Chain).
//
// It's UNCONFIRMED whether Robinhood Chain runs Timeboost (the paid express lane
// in front of Nitro's FCFS sequencer). Nothing here assumes it does:
//
// - `detectTimeboost` probes the RPC for `timeboost_*` methods and compares the
//   reply with a guaranteed-unknown method. It returns true only when the node
//   clearly knows the method, and false on any error.
// - `submitExpressLane` is a STUB behind an explicit flag. Its request shape follows
//   the public Arbitrum Timeboost spec (`timeboost_sendExpressLaneTransaction`) but
//   has NOT been verified against a live Robinhood node. Winning the auction, the
//   round number and the controller signature are the caller's job.

import { KeepAliveTransport, RpcError, type RpcClient } from "./keepalive.js";

export const TIMEBOOST_PROBE_METHODS = [
  "timeboost_sendExpressLaneTransaction",
  "auctioneer_submitAuctionResolutionTransaction",
] as const;

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

/** Probe an RPC (URL or client) for Timeboost support. Never throws. */
export async function detectTimeboost(rpc: string | RpcClient, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const owned = typeof rpc === "string" ? new KeepAliveTransport({ url: rpc, connections: 1, timeoutMs: opts.timeoutMs ?? 2_000 }) : undefined;
  const client: RpcClient = owned ?? (rpc as RpcClient);
  try {
    const control = await probe(client, `timeboost_zz_nonexistent_${Date.now().toString(36)}`);
    // Unreachable, or a permissive proxy that answers any method: can't tell, so no.
    if (control.kind !== "rpc") return false;
    for (const method of TIMEBOOST_PROBE_METHODS) {
      const r = await probe(client, method);
      if (r.kind === "network") return false;
      if (r.kind === "ok") return true;
      if (isUnknownMethod(r.error)) continue;
      // The node rejected our (deliberately empty) params differently from how it
      // rejects an unknown method: it knows the method.
      if (sameError(r.error, control.error)) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await owned?.close().catch(() => undefined);
  }
}

type ProbeResult = { kind: "ok" } | { kind: "rpc"; error: RpcError } | { kind: "network" };

async function probe(client: RpcClient, method: string): Promise<ProbeResult> {
  try {
    await client.request(method, []);
    return { kind: "ok" };
  } catch (e) {
    if (e instanceof RpcError && e.code !== undefined) return { kind: "rpc", error: e };
    return { kind: "network" };
  }
}

function isUnknownMethod(e: RpcError): boolean {
  if (e.code === METHOD_NOT_FOUND) return true;
  const m = e.message.toLowerCase();
  return (m.includes("method") && (m.includes("not found") || m.includes("not exist") || m.includes("unsupported") || m.includes("not available")))
    || m.includes("unknown variant");
}

function sameError(a: RpcError, b: RpcError): boolean {
  // Strip the method name so "unknown method X" and "unknown method Y" compare equal.
  const norm = (e: RpcError) => `${e.code}:${e.message.replace(/[a-z]+_[A-Za-z0-9_]+/g, "<m>")}`;
  return norm(a) === norm(b);
}

/**
 * An express-lane submission, per the Arbitrum Timeboost spec. UNVERIFIED for
 * Robinhood Chain. The caller builds and signs it with the round's express-lane
 * controller key (this package never handles that key).
 */
export interface ExpressLaneSubmission {
  chainId: `0x${string}`;
  round: `0x${string}`;
  auctionContractAddress: `0x${string}`;
  /** The signed raw tx (hex). */
  transaction: `0x${string}`;
  sequenceNumber: `0x${string}`;
  /** Controller signature over the submission. */
  signature: `0x${string}`;
  options?: Record<string, unknown> | null;
}

export interface ExpressLaneConfig {
  /** Must be explicitly true to attempt express-lane submission. Default off. */
  enabled: boolean;
  /** Endpoint for express-lane calls (defaults to the router's primary RPC). */
  rpcUrl?: string;
  /**
   * Builds a signed submission for one raw tx. Return undefined to skip the express
   * lane for that tx (for example when you don't control the current round).
   */
  buildSubmission(rawTx: `0x${string}`): Promise<ExpressLaneSubmission | undefined>;
}

/** STUB, UNVERIFIED: submit one tx via the Timeboost express lane. */
export async function submitExpressLane(rpc: RpcClient, cfg: ExpressLaneConfig, rawTx: `0x${string}`): Promise<boolean> {
  if (!cfg.enabled) throw new Error("express lane disabled (ExpressLaneConfig.enabled is false)");
  const submission = await cfg.buildSubmission(rawTx);
  if (!submission) return false;
  await rpc.request("timeboost_sendExpressLaneTransaction", [submission]);
  return true;
}
