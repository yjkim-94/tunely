import fs from "node:fs";
import path from "node:path";
const root = "out";
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((x) =>
      x.isDirectory() ? walk(path.join(dir, x.name)) : [path.join(dir, x.name)],
    );
}
const assets = walk(root).map(f => f.replaceAll("\\", "/"))
  .filter(
    (f) =>
      f.includes("/_next/static/") ||
      /\/(icon-[\w-]+\.png|apple-touch-icon\.png|favicon[\w-]*\.(png|svg)|manifest\.webmanifest)$/.test(f),
  )
  .map((f) => "/" + f.slice(root.length + 1));
const source = fs
  .readFileSync("public/sw.js", "utf8")
  .replace(/const CACHE\s*=\s*["'][^"']+["'];/, `const CACHE="tunely-${Date.now()}";`)
  .replace("self.__TUNELY_PRECACHE__", JSON.stringify(["/", ...assets]));
if (!source.includes("/_next/static/") || source.includes("self.__TUNELY_PRECACHE__")) throw new Error("Offline precache generation failed");
fs.writeFileSync("out/sw.js", source);
console.log(`Service Worker: ${assets.length + 1} offline assets`);
