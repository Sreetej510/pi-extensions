#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const packageDir = process.cwd();
const entry = join(packageDir, "src", "fargate-worker.ts");
const outfile = join(packageDir, "dist", "fargate-worker.mjs");
mkdirSync(dirname(outfile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __shipdCreateRequire } from "node:module"; globalThis.require = __shipdCreateRequire(import.meta.url);',
  },
  treeShaking: true,
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);
console.log(`Built ${outfile}`);
