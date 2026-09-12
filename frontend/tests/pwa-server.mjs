// Isolated loopback-only production-build fixture. No production credentials/data.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer } from "ws";

const root = resolve("dist");
let generation = 0;
let backendDown = false;
let frontendDown = false;
let frontendOffline = false;
let counter = 0;
const mime = { ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".html": "text/html" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4175");
  const path = url.pathname;
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  if (path === "/__test__/reset") { backendDown = frontendDown = frontendOffline = false; return json({ ok: true }); }
  if (path === "/__test__/update") { generation++; return json({ generation }); }
  if (path === "/__test__/backend-down") { backendDown = true; return json({ ok: true }); }
  if (path === "/__test__/frontend-offline") { frontendOffline = true; return json({ ok: true }); }
  if (path === "/__test__/frontend-down") { frontendDown = true; return json({ ok: true }); }
  if (path.startsWith("/api/")) {
    if (backendDown) return json({ detail: "Fixture backend unavailable" }, 503);
    if (path === "/api/health") return json({ status: "ok", app: "Ops Center", components: { database: "ok", redis: "ok" } });
    if (path === "/api/auth/me") {
      if (req.headers.authorization !== "Bearer pwa-test-only") return json({ detail: "Unauthorized" }, 401);
      return json({ id: "fixture", username: "PWA Test", role: "admin", is_active: true });
    }
    if (path === "/api/test/echo") {
      let body = "";
      for await (const chunk of req) body += chunk;
      return json({ counter: ++counter, method: req.method, authorization: req.headers.authorization, cookie: req.headers.cookie, csrf: req.headers["x-csrf-token"], body });
    }
    if (path === "/api/test/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write('data: {"live":true}\n\n');
      const timer = setInterval(() => res.write('data: {"live":true}\n\n'), 200);
      req.on("close", () => clearInterval(timer));
      return;
    }
    return json([]);
  }
  if (frontendOffline) { req.socket.destroy(); return; }
  if (frontendDown) { res.writeHead(503); return res.end("Frontend unavailable"); }
  let file = resolve(root, "." + path);
  if (!file.startsWith(root + "/") && file !== root) { res.writeHead(403); return res.end(); }
  try {
    let content;
    try { content = await readFile(file); }
    catch {
      if (extname(path)) { res.writeHead(404); return res.end(); }
      file = resolve(root, "index.html");
      content = await readFile(file);
    }
    if (path === "/sw.js") content = Buffer.concat([content, Buffer.from("\n// test generation " + generation)]);
    const immutable = path.startsWith("/assets/");
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": immutable ? "public, max-age=604800, immutable" : "no-store" });
    res.end(content);
  } catch { res.writeHead(500); res.end(); }
});
const sockets = new WebSocketServer({ server, path: "/api/test/socket" });
sockets.on("connection", socket => socket.on("message", message => socket.send(message.toString())));
server.listen(4175, "127.0.0.1");
