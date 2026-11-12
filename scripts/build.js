import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, "src"), path.join(dist, "internal"), { recursive: true });

const entry = await readFile(path.join(root, "index.js"), "utf8");
const originalImport = 'from "./src/generator.js"';
if (!entry.includes(originalImport)) {
  throw new Error("Cannot find the generator import in index.js");
}

await writeFile(
  path.join(dist, "index.js"),
  entry.replace(originalImport, 'from "./internal/generator.js"'),
);
await copyFile(path.join(root, "index.d.ts"), path.join(dist, "index.d.ts"));
await chmod(path.join(dist, "internal", "cli.js"), 0o755);

console.log("Built dist/index.js, dist/index.d.ts and the CLI.");
