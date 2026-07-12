#!/usr/bin/env node
/**
 * Build every non-private extension under extensions/*.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = join(root, "scripts", "build-extension.mjs");
const extensionsDir = join(root, "extensions");

for (const dirent of readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;

  const pkgDir = join(extensionsDir, dirent.name);
  const packageJsonPath = join(pkgDir, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.private) continue;

  console.log(`\n==> ${packageJson.name}`);
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nAll extensions built.");
