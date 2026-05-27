import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
  plugins: [
    react(),
    // Inlines all JS + CSS into the HTML so the backend only needs
    // to embed a single index.html file — no separate /assets/* chunks.
    viteSingleFile(),
  ],
  build: {
    outDir: "../src/web/dist-ui",
    emptyOutDir: true,
    // Raise the inline limit high enough that no asset is left external
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        // No code-splitting: one bundle, one file
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API and WebSocket traffic to the Bun backend
      "/api":   { target: "http://localhost:9000", changeOrigin: true },
      "/ws":    { target: "ws://localhost:9000",   ws: true },
    },
  },
})
