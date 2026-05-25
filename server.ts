import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import http from "http";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // API router or routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Binance API Proxy
  // This proxy handles requests to bypass browser CORS or local geo-blocking
  app.get("/api/binance", async (req, res) => {
    const apiPath = req.query.path as string;
    const isFutures = req.query.futures === "true";

    if (!apiPath) {
      res.status(400).json({ error: "Missing 'path' query parameter" });
      return;
    }

    const host = isFutures ? "https://fapi.binance.com" : "https://api.binance.com";
    const targetUrl = `${host}${apiPath}`;

    try {
      // Add standard realistic User-Agent to bypass cloud hosting filters
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        // If futures endpoint returns geo-block, try spot endpoint
        if (isFutures) {
          const spotPath = apiPath.replace('/fapi/v1/', '/api/v3/');
          const spotUrl = `https://api.binance.com${spotPath}`;
          const spotResp = await fetch(spotUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "application/json",
            }
          });
          if (spotResp.ok) {
            const data = await spotResp.json();
            res.json(data);
            return;
          }
        }
        res.status(response.status).json({ error: `Binance API error: ${response.statusText}` });
        return;
      }

      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      console.error(`Proxy Error fetching ${targetUrl}:`, error.message);
      res.status(502).json({ error: "Bad Gateway connecting to Binance", details: error.message });
    }
  });

  // Serve static UI / vite config
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in DEVELOPMENT mode with Vite Middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in PRODUCTION mode with static files serving...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Bind to 0.0.0.0 and PORT 3000
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Server boot failed:", err);
  process.exit(1);
});
