import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
