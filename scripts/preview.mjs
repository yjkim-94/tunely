import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
const args = process.argv.slice(2),
  i = args.indexOf("--port"),
  port = i >= 0 ? Number(args[i + 1]) : 3000;
const python =
  process.env.PYTHON_PATH ||
  (process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python");
const backend = spawn(
  python,
  ["-m", "uvicorn", "api.index:app", "--host", "127.0.0.1", "--port", "8000"],
  { stdio: "inherit" },
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const r = await fetch("http://127.0.0.1:8000" + req.url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
        duplex: "half",
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (r.body) Readable.fromWeb(r.body).pipe(res);
      else res.end();
      return;
    }
    const root = path.resolve("out"),
      target = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const file = fs.statSync(target).isDirectory()
      ? path.join(target, "index.html")
      : target;
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] || "application/octet-stream",
    );
    if (path.basename(file) === "sw.js")
      res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(port, "0.0.0.0");
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => {
    backend.kill(s);
    server.close();
    process.exit(0);
  });
