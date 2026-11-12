#!/usr/bin/env node
import fs from "node:fs/promises";
import { generateOpenApi } from "./generator.js";
const index = (key) => process.argv.indexOf(key);
const arg = (key, fallback) => index(key) >= 0 ? process.argv[index(key) + 1] : fallback;
try {
  const result = await generateOpenApi({
    root: arg("--root", process.cwd()), entry: arg("--entry", "src/app.js"),
    title: arg("--title", undefined), strict: index("--strict") >= 0,
  });
  const value = JSON.stringify(result.document, null, 2) + "\n";
  const out = arg("--out", null);
  if (out) await fs.writeFile(out, value); else process.stdout.write(value);
  for (const item of result.diagnostics) process.stderr.write(`[swaggerdoc-auto:${item.level}:${item.code}] ${item.message}\n`);
  process.stderr.write(`[swaggerdoc-auto] Scanned ${result.stats.scannedFiles} source files; found ${result.stats.routes} routes\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
