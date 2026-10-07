import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, type ArtifactStore } from "@/lib/artifacts/store";
import { documentsFor, reviseDocuments, snapshotRunDocuments } from "./documents";
import type { RunDocument } from "./schemas";

let root: string;
let worktree: string;
let outside: string;
let store: ArtifactStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cc-run-docs-store-"));
  worktree = await mkdtemp(path.join(tmpdir(), "cc-run-docs-worktree-"));
  outside = await mkdtemp(path.join(tmpdir(), "cc-run-docs-outside-"));
  store = createArtifactStore({ root });
});

afterEach(async () => {
  for (const dir of [root, worktree, outside]) await rm(dir, { recursive: true, force: true });
});

describe("documents frozen at launch", () => {
  it("snapshots a file from the session worktree and inline contents, each by its bytes", async () => {
    await mkdir(path.join(worktree, "docs"), { recursive: true });
    await writeFile(path.join(worktree, "docs/plan.md"), "# Plan\n");

    const result = await snapshotRunDocuments({
      requests: [
        { path: "plan.md", from: "docs/plan.md", description: "The plan", readWhen: "Before you start" },
        { path: "notes/glossary.md", contents: "terms\n", description: "Terms we use", appliesTo: ["build"] },
      ],
      worktreePath: worktree,
      store,
    });

    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.documents).toEqual([
      {
        path: "plan.md",
        artifactId: expect.stringMatching(/^sha256:/),
        bytes: 7,
        description: "The plan",
        readWhen: "Before you start",
      },
      {
        path: "notes/glossary.md",
        artifactId: expect.stringMatching(/^sha256:/),
        bytes: 6,
        description: "Terms we use",
        appliesTo: ["build"],
      },
    ]);
    expect((await store.read(result.documents[0]?.artifactId ?? "")).toString()).toBe("# Plan\n");
  });

  it("refuses, with each problem located, a missing file, one outside the worktree, a bad path and oversized bytes", async () => {
    await writeFile(path.join(outside, "secret.md"), "outside\n");
    await symlink(path.join(outside, "secret.md"), path.join(worktree, "link.md"));

    const result = await snapshotRunDocuments({
      requests: [
        { path: "a.md", from: "missing.md", description: "Missing" },
        { path: "b.md", from: "../escape.md", description: "Escapes" },
        { path: "c.md", from: "link.md", description: "Links out" },
        { path: "../d.md", contents: "x", description: "Bad path" },
        { path: "e.md", contents: "x".repeat(262_145), description: "Too big" },
        { path: "f.md", description: "Neither source" },
        { path: "a.md", contents: "again", description: "Duplicate path" },
      ],
      worktreePath: worktree,
      store,
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["documents", 0, "from"], message: expect.stringContaining("No file") },
        { path: ["documents", 1, "from"], message: expect.stringContaining("inside the session worktree") },
        { path: ["documents", 2, "from"], message: expect.stringContaining("inside the session worktree") },
        { path: ["documents", 3, "path"], message: expect.stringContaining("relative path") },
        { path: ["documents", 4], message: expect.stringContaining("262144 bytes") },
        { path: ["documents", 5], message: expect.stringContaining("exactly one of") },
        { path: ["documents", 6, "path"], message: expect.stringContaining("already") },
      ],
    });
  });
});

describe("declarations delivery could not write", () => {
  it("refuses a path that differs from another only by case, one that is a directory of another, control characters and an over-long name", async () => {
    const result = await snapshotRunDocuments({
      requests: [
        { path: "Plan.md", contents: "a", description: "A" },
        { path: "plan.md", contents: "b", description: "B" },
        { path: "notes/today.md", contents: "c", description: "C" },
        { path: "notes", contents: "d", description: "D" },
        { path: "bad\u0000name.md", contents: "e", description: "E" },
        { path: `${"x".repeat(201)}.md`, contents: "f", description: "F" },
        { path: "fine.md", contents: "g", description: "G" },
        { path: "Charter.md", contents: "h", description: "H" },
        { path: "charter.md/notes.md", contents: "i", description: "I" },
        { path: "CHARTER.MD/deep/notes.md", contents: "j", description: "J" },
        { path: "charter.md-notes.md", contents: "k", description: "K" },
        { path: "notes2/charter.md", contents: "l", description: "L" },
      ],
      worktreePath: worktree,
      store,
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["documents", 1, "path"], message: expect.stringContaining('"Plan.md"') },
        { path: ["documents", 3, "path"], message: expect.stringContaining('"notes/today.md"') },
        { path: ["documents", 4, "path"], message: expect.stringContaining("control") },
        { path: ["documents", 5, "path"], message: expect.stringContaining("200 bytes") },
        { path: ["documents", 7, "path"], message: expect.stringContaining("reserved for the run's charter") },
        { path: ["documents", 8, "path"], message: expect.stringContaining("reserved for the run's charter") },
        { path: ["documents", 9, "path"], message: expect.stringContaining("reserved for the run's charter") },
      ],
    });
  });

  it("reports a source file it cannot read at its declaration, and still checks the rest", async () => {
    await writeFile(path.join(worktree, "locked.md"), "secret\n");
    await chmod(path.join(worktree, "locked.md"), 0o000);
    await writeFile(path.join(worktree, "huge.md"), "x".repeat(262_145));

    const result = await snapshotRunDocuments({
      requests: [
        { path: "locked.md", from: "locked.md", description: "Locked" },
        { path: "huge.md", from: "huge.md", description: "Huge" },
        { path: "missing.md", from: "missing.md", description: "Missing" },
      ],
      worktreePath: worktree,
      store,
    });
    await chmod(path.join(worktree, "locked.md"), 0o644);

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["documents", 0, "from"], message: expect.stringContaining("could not be read") },
        { path: ["documents", 1], message: expect.stringContaining("262144 bytes") },
        { path: ["documents", 2, "from"], message: expect.stringContaining("No file") },
      ],
    });
  });
});

const doc = (path: string, artifactId: string, extra: Partial<RunDocument> = {}): RunDocument => ({
  path,
  artifactId,
  bytes: 1,
  description: `About ${path}`,
  ...extra,
});

describe("a run's document revisions", () => {
  it("records a revision only for a document that changed, and one for a document that went away", () => {
    const launched = reviseDocuments([], [doc("plan.md", "sha256:a"), doc("notes.md", "sha256:b")], "launch", "t1");
    const amended = reviseDocuments(
      launched,
      [doc("plan.md", "sha256:a"), doc("glossary.md", "sha256:c"), doc("notes.md", "sha256:b", { readWhen: "Now" })].filter(
        (d) => d.path !== "notes.md",
      ),
      "amend",
      "t2",
    );

    expect(amended.map((r) => [r.path, r.revision, r.source, r.document?.artifactId ?? null])).toEqual([
      ["plan.md", 1, "launch", "sha256:a"],
      ["notes.md", 1, "launch", "sha256:b"],
      ["glossary.md", 1, "amend", "sha256:c"],
      ["notes.md", 2, "amend", null],
    ]);
  });

  it("gives a context the latest revision of each document meant for it, in a directory of its own", () => {
    const revisions = reviseDocuments(
      reviseDocuments(
        [],
        [doc("plan.md", "sha256:a", { readWhen: "First" }), doc("build-notes.md", "sha256:b", { appliesTo: ["build"] })],
        "launch",
        "t1",
      ),
      [doc("plan.md", "sha256:a2", { readWhen: "First" }), doc("build-notes.md", "sha256:b", { appliesTo: ["build"] })],
      "amend",
      "t2",
    );

    expect(documentsFor({ revisions, contextId: "run-1.build", key: "build" })).toEqual([
      { artifactId: "sha256:a2", path: ".cc/run-docs/run-1.build/plan.md", description: "About plan.md", readWhen: "First" },
      { artifactId: "sha256:b", path: ".cc/run-docs/run-1.build/build-notes.md", description: "About build-notes.md" },
    ]);
    expect(documentsFor({ revisions, contextId: "run-1.review", key: "review" }).map((d) => d.path)).toEqual([
      ".cc/run-docs/run-1.review/plan.md",
    ]);
  });
});
