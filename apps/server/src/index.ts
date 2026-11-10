// @mint-engine/server: local-only dashboard HTTP + WebSocket server.
export { createServer, type DashboardServer, type ServerOptions, type LoopbackHost } from "./server.js";
export type { EnginePort, EngineListener, VaultPort } from "./ports.js";
export { createJobSchema, unlockSchema } from "./schemas.js";
export { FakeEngine, FakeVault, DEV_PASSPHRASE, type FakeEngineOptions } from "./dev-fakes.js";
