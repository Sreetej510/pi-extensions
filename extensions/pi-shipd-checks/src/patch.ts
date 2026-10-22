/** Unified-diff helpers shared by the solve reviewer workspace and the Auto Review reviewers. */

export interface PatchFile {
  path: string;
  isNew: boolean;
  /** The file's whole `diff --git` section. */
  text: string;
}

export function splitPatchFiles(patchText: string): PatchFile[] {
  return patchText
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "))
    .map((section) => {
      const path =
        section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ??
        section.match(/^diff --git a\/\S+ b\/(\S+)/)?.[1] ??
        section.match(/^--- a\/(.+)$/m)?.[1] ??
        "";
      return { path: path.trim(), isNew: /^new file mode /m.test(section), text: section };
    })
    .filter((file) => file.path !== "");
}

export function extractNewFilesFromPatch(patchText: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const sections = patchText.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    if (!/^new file mode /m.test(section)) continue;
    const patchPath = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!patchPath) continue;
    const normalizedPath = patchPath.replace(/\\/g, "/");
    if (
      normalizedPath.startsWith("/") ||
      /^[A-Za-z]:/.test(normalizedPath) ||
      normalizedPath.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(`Unsafe new-file path in test.patch: ${patchPath}`);
    }
    const content: string[] = [];
    const hasNoFinalNewline = section.includes("\\ No newline at end of file");
    let inHunk = false;
    for (const line of section.split(/\r?\n/)) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk || line === "" || line.startsWith("\\ No newline at end of file")) continue;
      if (line.startsWith("+")) content.push(line.slice(1));
      else if (line.startsWith("diff --git ")) break;
      else throw new Error(`Unexpected non-addition line in new test.patch file ${patchPath}.`);
    }
    const fileContent = content.join("\n");
    files.push({ path: normalizedPath, content: hasNoFinalNewline ? fileContent : `${fileContent}\n` });
  }
  return files;
}

/** Splits a patch into its hunks; each hunk carries its file and the `@@` header's trailing context (usually the enclosing function). */
export function splitPatchHunks(
  patchText: string,
): Array<{ file: string; header: string; context: string; text: string }> {
  const hunks: Array<{ file: string; header: string; context: string; text: string }> = [];
  for (const file of splitPatchFiles(patchText)) {
    const parts = file.text.split(/(?=^@@ )/m).slice(1);
    for (const part of parts) {
      const header = part.match(/^@@[^@]*@@/)?.[0] ?? "@@";
      const context = part.match(/^@@[^@]*@@ ?(.*)$/m)?.[1]?.trim() ?? "";
      hunks.push({ file: file.path, header, context, text: part });
    }
  }
  return hunks;
}
