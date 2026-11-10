// Local-chain endpoints. Every helper takes URLs as parameters; these are only the defaults.
// Env vars let parallel test runs point at their own containers (e.g. E2E_BASE_RPC=http://127.0.0.1:22346).

export interface LocalEndpoints {
  eth: string;
  base: string;
  robinhood: string;
  solanaRpc: string;
  solanaWs: string;
}

export function localEndpoints(env: NodeJS.ProcessEnv = process.env): LocalEndpoints {
  return {
    eth: env.E2E_ETH_RPC ?? "http://127.0.0.1:8545",
    base: env.E2E_BASE_RPC ?? "http://127.0.0.1:8546",
    robinhood: env.E2E_ROBINHOOD_RPC ?? "http://127.0.0.1:8547",
    solanaRpc: env.E2E_SOLANA_RPC ?? "http://127.0.0.1:8899",
    solanaWs: env.E2E_SOLANA_WS ?? "ws://127.0.0.1:8900",
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "host.docker.internal"]);

/** True for loopback / docker-host / *.localhost / *.test URLs. */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".test");
}

/**
 * Fixtures deploy contracts with well-known dev keys and airdrop funds; refuse anything that is not a local chain.
 * Set MINT_ENGINE_FIXTURES_ALLOW_REMOTE=1 only for a private devnet you control.
 */
export function assertLocalRpc(url: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isLocalUrl(url)) return;
  if (env.MINT_ENGINE_FIXTURES_ALLOW_REMOTE === "1") return;
  throw new Error(`@mint-engine/fixtures refuses non-local RPC ${url}. Fixtures are for local chains only.`);
}
