import { defineConfig } from "vitest/config";

// E2E tests need local chains (see test/vault.e2e.test.ts for the env vars).
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
