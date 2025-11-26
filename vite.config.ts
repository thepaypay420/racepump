import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
        // Ensure we're using the same version of web3.js everywhere
        "@solana/web3.js": path.resolve(import.meta.dirname, "node_modules/@solana/web3.js"),
      },
      // Deduplicate modules
      dedupe: ["@solana/web3.js", "bn.js"],
    },
    optimizeDeps: {
      // Force pre-bundling of these modules
      include: ["@solana/web3.js", "bn.js"],
    // Exclude modules that shouldn't be optimized
    exclude: [],
    esbuildOptions: {
      // Ensure BigInt is supported
      target: "es2020",
    },
  },
  define: {
    // Polyfill global for browser
    global: "globalThis",
    // Ensure process.env is available
    "process.env": {},
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
