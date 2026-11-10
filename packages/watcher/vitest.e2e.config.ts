import { defineConfig } from "vitest/config";

// E2E tests run against a local anvil (never mainnet). See test/watcher.e2e.test.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
