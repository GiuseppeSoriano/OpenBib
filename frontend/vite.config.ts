import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { graphCspPlugin } from "./graph-csp-plugin";

export default defineConfig({
  plugins: [graphCspPlugin(), react()],
  build: { rollupOptions: { input: { main: resolve(__dirname, "index.html"), docs: resolve(__dirname, "api-docs.html") } } },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  optimizeDeps: { exclude: ["react-force-graph-2d", "force-graph", "float-tooltip"] },
  server: {
    port: 5173,
    // Polling keeps file watching reliable on Docker bind mounts (Windows).
    watch: { usePolling: !!process.env.CHOKIDAR_USEPOLLING },
    proxy: {
      "/api": {
        // Inside the web-dev container the API lives at http://api:8000.
        target: process.env.VITE_PROXY_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // Vitest blanks CSS imports by default; keep `?raw` ones for the layout contract test.
    css: { include: [/\.css\?raw$/] },
  },
});
