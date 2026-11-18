import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the screen talks to a local pitwall-api (pitwall service api --port 8104).
const api = process.env.PITWALL_API ?? "http://127.0.0.1:8104";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
