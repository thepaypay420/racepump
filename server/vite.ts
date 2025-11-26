import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "..", "dist", "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Serve static files from the dist/public directory with proper cache headers
  app.use(
    express.static(distPath, {
      setHeaders: (res, filePath) => {
        try {
          const isIndex = filePath.endsWith(path.sep + "index.html");
          const isAsset = filePath.includes(path.sep + "assets" + path.sep);
          if (isIndex) {
            // Ensure fresh HTML so clients pick up new asset hashes after deploys
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          } else if (isAsset) {
            // Hashed assets can be cached aggressively
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            // Other static files (images, icons)
            res.setHeader("Cache-Control", "public, max-age=3600");
          }
        } catch {}
      },
    }),
  );

  // Serve index.html for the root path and any unmatched routes (SPA fallback)
  app.get("*", (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "API endpoint not found" });
    }
    
    const indexPath = path.resolve(distPath, "index.html");
    if (fs.existsSync(indexPath)) {
      // Double-set in case a proxy strips static headers
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.sendFile(indexPath);
    } else {
      res.status(404).send("index.html not found");
    }
  });
}
