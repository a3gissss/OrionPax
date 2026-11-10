// Dev entrypoint: dashboard server with in-memory fakes.
// Usage: node dist/main.js [--port N]   (or PORT=N). Port 0 picks a random port.

import { DEFAULT_SERVER_PORT } from "@mint-engine/core";
import { createServer } from "./server.js";
import { DEV_PASSPHRASE, FakeEngine, FakeVault } from "./dev-fakes.js";

function parsePort(): number {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && (process.argv[i + 1] === undefined || process.argv[i + 1] === "")) throw new Error("--port needs a value");
  const raw = i !== -1 ? process.argv[i + 1] : process.env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${raw}`);
  return n;
}

const vault = new FakeVault(process.env.MINT_ENGINE_DEV_PASSPHRASE || DEV_PASSPHRASE);
const server = createServer({
  engine: new FakeEngine({ wallets: vault.refs() }),
  vault,
  port: parsePort(),
  log: (line) => console.log(`[server] ${line}`),
});

const { port, url } = await server.listen();
console.log(`mint-engine dashboard server (DEV FAKES) listening on ${url}`);
console.log(`MINT_ENGINE_PORT=${port}`);
console.log(`MINT_ENGINE_TOKEN=${server.token}`);
console.log(`Open ${url}/#token=${server.token}`);
if (!process.env.MINT_ENGINE_DEV_PASSPHRASE) console.log(`Dev vault passphrase: "${DEV_PASSPHRASE}" (fake vault, no real keys)`);

const shutdown = () => { void server.close().then(() => process.exit(0)); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
