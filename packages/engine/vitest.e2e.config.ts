import { defineConfig } from "vitest/config";

// The root config excludes *.e2e.test.ts; this one runs only them.
export default defineConfig({
  test: { include: ["test/**/*.e2e.test.ts"], testTimeout: 60_000 },
});
