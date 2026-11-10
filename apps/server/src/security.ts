// Local-only access checks: loopback Host/Origin (DNS-rebinding protection) and session token.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hostname part of a Host header ("localhost:4810" -> "localhost", "[::1]:80" -> "[::1]"). */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}

/** Absent Origin (curl, same-origin GET) is allowed; present Origin must be http(s)://loopback. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

export function checkRequestOrigin(req: IncomingMessage): boolean {
  return isLoopbackHost(req.headers.host) && isAllowedOrigin(req.headers.origin);
}

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** WS subprotocol contract shared with apps/web (browsers can't set WS headers). */
export const WS_PROTOCOL = "mint-engine";
export const WS_TOKEN_PROTOCOL_PREFIX = "token.";

export function encodeTokenProtocol(token: string): string {
  return WS_TOKEN_PROTOCOL_PREFIX + Buffer.from(token, "utf8").toString("base64url");
}

export function decodeTokenProtocol(protocol: string): string | null {
  if (!protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return null;
  const b64 = protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]*$/.test(b64)) return null;
  return Buffer.from(b64, "base64url").toString("utf8");
}

/** Token from `X-Session-Token: <t>` (used by apps/web) or `Authorization: Bearer <t>`. */
export function tokenFromHeaders(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-session-token"];
  return typeof x === "string" ? x : undefined;
}
