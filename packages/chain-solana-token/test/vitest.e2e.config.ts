import { defineConfig } from "vitest/config";

// E2E only: needs a local solana-test-validator (E2E_SOLANA_RPC / E2E_SOLANA_WS).
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
