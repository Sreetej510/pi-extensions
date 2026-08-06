import { posix as posixPath } from "node:path";

export interface FargateDockerPlan {
  baseImage: string;
  workdir: string;
  env: Record<string, string>;
  runtimeCommands: string[];
}

/**
 * Parse the Dockerfile subset the Fargate worker can reproduce after uploading
 * a clean repository snapshot. COPY is intentionally ignored because the
 * snapshot is extracted separately; shell-form RUN commands are run in the
 * task before solver workspaces are created.
 */
export function parseFargateDockerfile(contents: string): FargateDockerPlan {
  let baseImage: string | undefined;
  let workdir = "/";
  const env: Record<string, string> = {};
  const runtimeCommands: string[] = [];

  for (const instruction of logicalInstructions(contents)) {
    const match = instruction.match(/^([A-Za-z]+)(?:\s+(.+))?$/s);
    if (!match) throw new Error(`Invalid Dockerfile instruction: ${instruction}`);
    const name = match[1]?.toUpperCase();
    const rest = match[2]?.trim() ?? "";
    switch (name) {
      case "FROM": {
        if (baseImage) throw new Error("Multi-stage Dockerfiles are not supported by the Fargate runner.");
        const words = shellWords(rest);
        if (!words[0] || words.some((word) => word.startsWith("--") || word.toUpperCase() === "AS")) {
          throw new Error(`Unsupported FROM instruction: ${instruction}`);
        }
        baseImage = words[0];
        break;
      }
      case "WORKDIR":
        if (!rest || rest.includes("$") || rest.includes("\\")) {
          throw new Error(`WORKDIR must be a concrete POSIX path: ${instruction}`);
        }
        workdir = posixPath.resolve(workdir, rest);
        break;
      case "ENV":
        parseEnv(rest, env);
        break;
      case "COPY":
        if (shellWords(rest).length < 2 || shellWords(rest).some((word) => word.startsWith("--"))) {
          throw new Error(`COPY flags and malformed COPY instructions are not supported: ${instruction}`);
        }
        break;
      case "RUN":
        if (!rest || rest.startsWith("--") || rest.startsWith("[")) {
          throw new Error(`Only shell-form RUN instructions without options are supported: ${instruction}`);
        }
        runtimeCommands.push(rest);
        break;
      case "CMD":
      case "ENTRYPOINT":
      case "LABEL":
      case "EXPOSE":
        break;
      default:
        throw new Error(`Unsupported Dockerfile instruction for Fargate execution: ${name}`);
    }
  }

  if (!baseImage) throw new Error("Dockerfile is missing a FROM instruction.");
  return { baseImage, workdir, env, runtimeCommands };
}

function parseEnv(rest: string, target: Record<string, string>): void {
  const words = shellWords(rest);
  if (words.length === 0) throw new Error("ENV requires a variable assignment.");
  if (words[0]?.includes("=")) {
    for (const word of words) {
      const separator = word.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid ENV assignment: ${word}`);
      target[word.slice(0, separator)] = word.slice(separator + 1);
    }
    return;
  }
  if (words.length < 2) throw new Error(`ENV requires a value: ${rest}`);
  target[words[0] as string] = words.slice(1).join(" ");
}

function logicalInstructions(contents: string): string[] {
  const result: string[] = [];
  let pending = "";
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!pending && /^\s*#/.test(line)) continue;
    const combined = pending ? `${pending}${line.trimStart()}` : line.trimStart();
    if (endsWithContinuation(combined)) pending = `${combined.slice(0, -1).trimEnd()} `;
    else {
      if (combined.trim()) result.push(combined.trim());
      pending = "";
    }
  }
  if (pending.trim()) result.push(pending.trim());
  return result;
}

function endsWithContinuation(line: string): boolean {
  let slashCount = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error(`Unterminated quote in Dockerfile instruction: ${value}`);
  if (current) words.push(current);
  return words;
}
