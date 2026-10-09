import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceEvidence } from "./evidence";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
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
    expect(
      await evidence.changedPaths(repo, { mode: "full" }, before, after),
    ).toEqual(["src/api/new.ts", "src/api/routes.ts"]);
  });

  it("shows what a capture changed from the committed head, within its scope, whatever changed after it", async () => {
    write("src/api/routes.ts", "export const a = 2;\n");
    write("src/ui/view.ts", "export const v = 2;\n");
    const owned = { mode: "owned" as const, paths: ["src/api"] };
    const captured = await evidence.capture(repo, owned);
    write("src/api/routes.ts", "export const a = 3;\n");

    const diff = await evidence.changes(repo, owned, captured);

    expect(diff.files.map((file) => file.filePath)).toEqual([
      "src/api/routes.ts",
    ]);
    expect(diff.totalAdditions).toBe(1);
    expect(diff.totalDeletions).toBe(1);
    expect(JSON.stringify(diff)).toContain("export const a = 2;");
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

  it("sees a same-size edit made in the same second the worktree index was written", async () => {
    // Pin the racy case: the entry's stat and the index's timestamp share one
    // second, so only git's racy-entry check forces the file to be rehashed.
    git("config", "core.trustctime", "false");
    const past = new Date("2020-01-01T00:00:00Z");
    const view = path.join(repo, "src/ui/view.ts");
    utimesSync(view, past, past);
    git("update-index", "--refresh");
    utimesSync(path.join(repo, ".git", "index"), past, past);
    const before = await evidence.capture(repo, { mode: "full" });

    write("src/ui/view.ts", "export const v = 2;\n");
    utimesSync(view, past, past);
    const after = await evidence.capture(repo, { mode: "full" });

    expect(evidence.sameContent(before, after)).toBe(false);
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
    expect(await evidence.changedPaths(repo, scope, before, inside)).toEqual([
      "src/api/routes.ts",
    ]);
  });

  it("reads owned paths literally: a path with pattern characters owns only itself", async () => {
    write("src/app/[id]/page.tsx", "export const p = 1;\n");
    write("src/app/i/page.tsx", "export const q = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "pages");
    const scope = {
      mode: "owned" as const,
      paths: ["src/app/[id]/page.tsx"],
    };
    const before = await evidence.capture(repo, scope);
    write("src/app/i/page.tsx", "export const q = 2;\n");
    const sibling = await evidence.capture(repo, scope);
    write("src/app/[id]/page.tsx", "export const p = 2;\n");
    const owned = await evidence.capture(repo, scope);

    expect(evidence.sameContent(before, sibling)).toBe(true);
    expect(await evidence.changedPaths(repo, scope, before, owned)).toEqual([
      "src/app/[id]/page.tsx",
    ]);
    const diff = await evidence.changes(repo, scope, owned);
    expect(diff.files.map((file) => file.filePath)).toEqual([
      "src/app/[id]/page.tsx",
    ]);
  });

  it("shows a candidate's changes from the head it was captured on, after the branch moves", async () => {
    write("src/api/routes.ts", "export const a = 2;\n");
    const captured = await evidence.capture(repo, { mode: "full" });
    // Someone commits the candidate's file, and another, while it awaits approval.
    write("src/ui/view.ts", "export const v = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "moved on");

    const diff = await evidence.changes(repo, { mode: "full" }, captured);

    expect(diff.files.map((file) => file.filePath)).toEqual([
      "src/api/routes.ts",
    ]);
  });
});
