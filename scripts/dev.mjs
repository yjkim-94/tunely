import { spawn } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
const i = args.indexOf("--port");
const port = i >= 0 ? args[i + 1] : "3000";
const python =
  process.env.PYTHON_PATH ||
  (process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python");
if (!fs.existsSync(python) && !process.env.PYTHON_PATH) {
  console.error(
    "먼저 Python 가상환경을 만들고 requirements.txt를 설치하세요. README.md를 참고하세요.",
  );
  process.exit(1);
}
const backend = spawn(
  python,
  ["-m", "uvicorn", "api.index:app", "--host", "127.0.0.1", "--port", "8000"],
  { stdio: "inherit" },
);
const frontend = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--hostname",
    "0.0.0.0",
    "--port",
    port,
  ],
  { stdio: "inherit" },
);
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => {
    backend.kill(s);
    frontend.kill(s);
  });
for (const child of [backend, frontend])
  child.on("error", (e) => {
    console.error(e.message);
    backend.kill();
    frontend.kill();
    process.exit(1);
  });
frontend.on("exit", (code) => {
  backend.kill();
  process.exit(code ?? 1);
});
