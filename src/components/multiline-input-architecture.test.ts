import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.(test|stories)\.tsx?$/.test(entry.name)) return [];
      return [entryPath];
    }),
  );
  return nested.flat();
}

describe("multiline input architecture", () => {
  it("allows raw production textareas only inside the shared native adapter", async () => {
    const root = path.join(process.cwd(), "src");
    const files = await sourceFiles(root);
    const rawTextareaFiles: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/<textarea(?:\s|>)/.test(source)) {
        rawTextareaFiles.push(path.relative(process.cwd(), file));
      }
    }

    expect(rawTextareaFiles).toEqual(["src/components/MultilineInput.tsx"]);
  });
});
