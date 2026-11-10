import { defineConfig } from "vitest/config";

// E2E against local Docker chains. RPC URLs come from E2E_* env vars (see src/env.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
