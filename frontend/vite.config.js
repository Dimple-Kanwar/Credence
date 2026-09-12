import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @worldcoin/agentkit's ESM bundle imports Node's `crypto` at the top
      // level (from its server-side resource extension, never executed in the
      // browser). Vite would otherwise fail to bind the `randomBytes` named
      // export during the build, so point `crypto` at a tiny Web Crypto shim.
      crypto: fileURLToPath(new URL("./src/vendor/node-crypto-shim.js", import.meta.url)),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});