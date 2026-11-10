// Wires fetch + WebSocket in jsdom to the in-memory MockBackend.
import { vi } from "vitest";
import { MockBackend } from "../src/mock/backend";
import { TOKEN_HEADER, decodeTokenProtocol } from "../src/lib/api";

export function installMockBackend(opts: ConstructorParameters<typeof MockBackend>[0] = {}) {
  const backend = new MockBackend({ speed: 0, ...opts });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const out = backend.handle(init?.method ?? "GET", new URL(url, "http://localhost").pathname, headers.get(TOKEN_HEADER), body);
    return new Response(JSON.stringify(out.body ?? null), { status: out.status, headers: { "content-type": "application/json" } });
  }));

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    private off: (() => void) | null = null;
    private closed = false;
    constructor(_url: string, protocols: string[] = []) {
      const token = protocols.map(decodeTokenProtocol).find((t) => t !== null);
      queueMicrotask(() => {
        if (this.closed) return;
        if (!backend.checkToken(token)) {
          this.onclose?.();
          return;
        }
        this.onopen?.();
        this.off = backend.subscribe((m) => this.onmessage?.({ data: JSON.stringify(m) }));
      });
    }
    close() {
      this.closed = true;
      this.off?.();
      this.onclose?.();
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return backend;
}
