import http from "http";
import fs from "fs";
import path from "path";
import { getAllMetrics } from "./metrics.js";
import { endpoints } from "./endpoints.js";

const PORT = 3402;
const PUBLIC_DIR = path.join(process.cwd(), "public");

export function startDashboard(): void {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/health" && req.method === "GET") {
      const metrics = getAllMetrics(endpoints.map((e) => e.url));
      const payload = metrics.map((m) => {
        const endpoint = endpoints.find((e) => e.url === m.url);
        return { ...m, name: endpoint?.name, description: endpoint?.description };
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ endpoints: payload, generatedAt: new Date().toISOString() }));
      return;
    }

    if (url === "/" && req.method === "GET") {
      const htmlPath = path.join(PUBLIC_DIR, "index.html");
      try {
        const html = fs.readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Could not load dashboard");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`Health API: http://localhost:${PORT}/api/health`);
  });
}
