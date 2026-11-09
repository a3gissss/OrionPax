import { defineConfig } from "vitest/config";

// E2E: needs local anvil chains (see test/launchpad.e2e.test.ts for E2E_BASE_RPC / E2E_ROBINHOOD_RPC).
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
