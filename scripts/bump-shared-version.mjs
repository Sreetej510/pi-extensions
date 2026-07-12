#!/usr/bin/env node
/**
 * Bumps the root package.json version and every non-private workspace
 * package under extensions/*, keeping them all in lockstep on one shared
 * version number. Prints the new version as the last line of stdout so CI
 * can capture it, e.g.:
 *
 *   node scripts/bump-shared-version.mjs patch
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const VALID_BUMPS = new Set(["major", "minor", "patch"]);
const bump = process.argv[2];

if (!VALID_BUMPS.has(bump)) {
  console.error(`Usage: node scripts/bump-shared-version.mjs <major|minor|patch>`);
  process.exit(1);
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Cannot parse semver version: ${version}`);
  }
  let [, major, minor, patch] = match.map(Number);
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const rootPackagePath = "package.json";
const rootPackage = readJson(rootPackagePath);
const newVersion = bumpVersion(rootPackage.version, bump);

rootPackage.version = newVersion;
writeJson(rootPackagePath, rootPackage);

const extensionsDir = "extensions";
for (const dirent of readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;

  const packageJsonPath = join(extensionsDir, dirent.name, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const packageJson = readJson(packageJsonPath);
  packageJson.version = newVersion;
  writeJson(packageJsonPath, packageJson);
}

console.log(`Bumped ${bump} version -> ${newVersion}`);
console.log(newVersion);
