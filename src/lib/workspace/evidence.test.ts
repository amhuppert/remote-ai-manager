import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceEvidence } from "./evidence";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), contents);
};

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "cc-evidence-test-"));
  git("init", "-q");
  write(".gitignore", "ignored/\n");
  write("src/api/routes.ts", "export const a = 1;\n");
  write("src/ui/view.ts", "export const v = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const evidence = createWorkspaceEvidence();

describe("workspace evidence", () => {
  it("identifies working-tree content and names what changed between captures", async () => {
    const before = await evidence.capture(repo, { mode: "full" });
    write("src/api/routes.ts", "export const a = 2;\n");
    write("src/api/new.ts", "export const n = 1;\n");
    const after = await evidence.capture(repo, { mode: "full" });

    expect(evidence.sameContent(before, after)).toBe(false);
    expect(await evidence.changedPaths(repo, { mode: "full" }, before, after)).toEqual([
      "src/api/new.ts",
      "src/api/routes.ts",
    ]);
  });

  it("ignores ignored files and survives an owner's commit of unchanged content", async () => {
    const before = await evidence.capture(repo, { mode: "full" });
    write("ignored/cache.bin", "noise");
    write("src/ui/view.ts", "export const v = 2;\n");
    const edited = await evidence.capture(repo, { mode: "full" });
    git("commit", "-qam", "owner commit");
    const committed = await evidence.capture(repo, { mode: "full" });

    expect(evidence.sameContent(before, edited)).toBe(false);
    expect(evidence.sameContent(edited, committed)).toBe(true);
  });

  it("compares an owned scope only within its paths", async () => {
    const scope = { mode: "owned" as const, paths: ["src/api"] };
    const before = await evidence.capture(repo, scope);
    write("src/ui/view.ts", "export const v = 3;\n");
    const outside = await evidence.capture(repo, scope);
    write("src/api/routes.ts", "export const a = 3;\n");
    const inside = await evidence.capture(repo, scope);

    expect(evidence.sameContent(before, outside)).toBe(true);
    expect(evidence.sameContent(outside, inside)).toBe(false);
    expect(await evidence.changedPaths(repo, scope, before, inside)).toEqual(["src/api/routes.ts"]);
  });
});
