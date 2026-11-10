// Dashboard server entrypoint.
//   node dist/main.js [--port N]                     dev fakes (no real keys or chains)
//   node dist/main.js --config mint-engine.config.json [--port N]   real engine + vault
// PORT=N also works. Port 0 picks a random port. MINT_ENGINE_CONFIG=path also selects real mode.

import { DEFAULT_SERVER_PORT } from "@mint-engine/core";
import { createServer } from "./server.js";
import { DEV_PASSPHRASE, FakeEngine, FakeVault } from "./dev-fakes.js";
import { createRealBackend, loadConfig } from "./real.js";
import type { EnginePort, VaultPort } from "./ports.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function parsePort(): number {
  const raw = argValue("--port") ?? process.env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${raw}`);
  return n;
}

const configPath = argValue("--config") ?? process.env.MINT_ENGINE_CONFIG;
let engine: EnginePort;
let vault: VaultPort;
let mode: string;

if (configPath) {
  const cfg = await loadConfig(configPath);
  const backend = await createRealBackend(cfg);
  engine = backend.engine;
  vault = backend.vault;
  mode = `REAL (${Object.keys(cfg.chains).join(", ")})`;
  const unfinished = backend.restored.filter((j) => !["done", "failed", "cancelled"].includes(j.status));
  if (unfinished.length) {
    console.log(`[server] ${unfinished.length} unfinished job(s) restored from the ledger; they are NOT resumed automatically.`);
    console.log(`[server] Wallets already sent are never re-sent. Cancel them from the dashboard if no longer wanted.`);
  }
} else {
  const fake = new FakeVault(process.env.MINT_ENGINE_DEV_PASSPHRASE || DEV_PASSPHRASE);
  engine = new FakeEngine({ wallets: fake.refs() });
  vault = fake;
  mode = "DEV FAKES";
}

const server = createServer({ engine, vault, port: parsePort(), log: (line) => console.log(`[server] ${line}`) });

const { port, url } = await server.listen();
console.log(`mint-engine dashboard server (${mode}) listening on ${url}`);
console.log(`MINT_ENGINE_PORT=${port}`);
console.log(`MINT_ENGINE_TOKEN=${server.token}`);
console.log(`Open ${url}/#token=${server.token}`);
if (!configPath && !process.env.MINT_ENGINE_DEV_PASSPHRASE) {
  console.log(`Dev vault passphrase: "${DEV_PASSPHRASE}" (fake vault, no real keys)`);
}

const shutdown = () => { void server.close().then(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
