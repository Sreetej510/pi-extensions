#!/usr/bin/env node
/**
 * Build every non-private extension under extensions/* using its package build script.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = join(root, "extensions");
const buildCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const buildArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm run build"] : ["run", "build"];

for (const dirent of readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;

  const pkgDir = join(extensionsDir, dirent.name);
  const packageJsonPath = join(pkgDir, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.private) continue;

  console.log(`\n==> ${packageJson.name}`);
  const result = spawnSync(buildCommand, buildArgs, {
    cwd: pkgDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nAll extensions built.");
