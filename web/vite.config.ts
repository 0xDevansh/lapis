import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Proxy API calls to the local Wrangler dev server during web-only dev
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
