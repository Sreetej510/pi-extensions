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
  // Keep pi-ai as one bundled instance so the OAuth loader registration below
  // also reaches the copy used by pi-coding-agent.
  alias: {
    "@earendil-works/pi-ai": join(packageDir, "../../node_modules/@earendil-works/pi-ai/dist"),
    "pi-commandcode-provider": join(packageDir, "../../node_modules/pi-commandcode-provider/index.ts"),
  },
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __shipdCreateRequire } from "node:module"; globalThis.require = __shipdCreateRequire(import.meta.url);',
  },
  treeShaking: true,
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);
console.log(`Built ${outfile}`);
