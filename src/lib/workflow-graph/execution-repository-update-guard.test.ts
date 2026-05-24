import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.resolve(ROOT_DIR);

const UPDATE_DETECTOR = /executionRepository(?:\?\.|\.)\s*update\s*\(/;
const MUTATE_ACTIVE_DETECTOR =
  /executionRepository(?:\?\.|\.)\s*mutateActive\s*\(/;

const MANAGER_FILE_RELATIVE = path.join(
  "lib",
  "workflow-graph",
  "workflow-manager.ts",
);

async function collectProductionSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectProductionSourceFiles(fullPath);
      results.push(...nested);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    if (/\.test\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    if (/\.stories\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    results.push(fullPath);
  }

  return results;
}

describe("executionRepository write-call guard", () => {
  it("executionRepository.update is not called from any production module — all writes must go through GraphWorkflowManager.mutateActive", async () => {
    const files = await collectProductionSourceFiles(SRC_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, "utf8");
      if (UPDATE_DETECTOR.test(contents)) {
        offenders.push(path.relative(ROOT_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("modules that instantiate the raw execution repository must never call .mutateActive on it directly — that bypasses GraphWorkflowManager", async () => {
    const files = await collectProductionSourceFiles(SRC_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      const relativeFromSrc = path.relative(SRC_DIR, file);
      if (relativeFromSrc === MANAGER_FILE_RELATIVE) {
        continue;
      }
      const contents = await readFile(file, "utf8");
      const createsRawRepo = /createGraphWorkflowExecutionRepository\s*\(/.test(
        contents,
      );
      if (createsRawRepo && MUTATE_ACTIVE_DETECTOR.test(contents)) {
        offenders.push(path.relative(ROOT_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
