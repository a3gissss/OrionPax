import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { mockServerPlugin } from "./src/mock-server";

const API_TARGET = "http://127.0.0.1:4810";

// `@mint-engine/core` is consumed from source so the dashboard builds without `tsc -b` first.
export const coreAlias = {
  "@mint-engine/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
};

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()];
  if (mode === "mock") plugins.push(mockServerPlugin());
  return {
    plugins,
    resolve: { alias: coreAlias },
    server: {
      host: "127.0.0.1",
      // In mock mode the in-process mock backend answers /api and /ws; otherwise proxy to the local server.
      proxy: mode === "mock" ? undefined : {
        "/api": { target: API_TARGET, changeOrigin: false },
        "/ws": { target: API_TARGET.replace("http", "ws"), ws: true },
      },
    },
    build: { outDir: "dist", sourcemap: true },
  };
});
