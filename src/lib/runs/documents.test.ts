import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, type ArtifactStore } from "@/lib/artifacts/store";
import {
  MAX_RUN_DOCUMENTS_BYTES,
  currentDocuments,
  documentsFor,
  publishDocument,
  reviseDocuments,
  snapshotDocumentFile,
  snapshotRunDocuments,
} from "./documents";
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

describe("published documents", () => {
  const launched = reviseDocuments(
    [],
    [doc("plan.md", "sha256:a", { readWhen: "First" }), doc("notes.md", "sha256:b", { appliesTo: ["build"] })],
    "launch",
    "t1",
  );

  it("publishes one document as a new revision, keeping what it said about itself, and nothing new for the same bytes", () => {
    const published = publishDocument(launched, { path: "plan.md", artifactId: "sha256:a2", bytes: 9, by: "run-1.build" }, "t2");
    if (!published.ok) throw new Error(published.reason);

    expect(published).toMatchObject({ revision: 2, unchanged: false });
    expect(published.revisions.at(-1)).toEqual({
      path: "plan.md",
      revision: 2,
      source: "publish",
      at: "t2",
      by: "run-1.build",
      document: { artifactId: "sha256:a2", bytes: 9, description: "About plan.md", readWhen: "First" },
    });
    expect(currentDocuments(published.revisions).map((r) => [r.path, r.revision])).toEqual([
      ["plan.md", 2],
      ["notes.md", 1],
    ]);

    const again = publishDocument(published.revisions, { path: "plan.md", artifactId: "sha256:a2", bytes: 9, by: "run-1.docs" }, "t3");
    expect(again).toEqual({ ok: true, revisions: published.revisions, revision: 2, unchanged: true });

    const notes = publishDocument(launched, { path: "notes.md", artifactId: "sha256:b2", bytes: 3, by: "run-1.build", description: "Build notes" }, "t2");
    expect(notes.ok && notes.revisions.at(-1)?.document).toEqual({
      artifactId: "sha256:b2",
      bytes: 3,
      description: "Build notes",
      appliesTo: ["build"],
    });
  });

  it("refuses what a declaration would refuse: no description for a new document, the charter's name, a collision, the run's total", () => {
    const refusal = (published: Parameters<typeof publishDocument>[1]) => {
      const result = publishDocument(launched, published, "t2");
      return result.ok ? null : result.reason;
    };
    const base = { artifactId: "sha256:x", bytes: 1, by: "run-1.build" };

    expect(refusal({ ...base, path: "new.md" })).toMatch(/needs a description/);
    expect(refusal({ ...base, path: "charter.md/x.md", description: "X" })).toMatch(/reserved for the run's charter/);
    expect(refusal({ ...base, path: "Plan.md", description: "X" })).toMatch(/only by case/);
    expect(refusal({ ...base, path: "plan.md/x.md", description: "X" })).toMatch(/directory/);
    expect(refusal({ ...base, path: "plan.md", bytes: MAX_RUN_DOCUMENTS_BYTES })).toMatch(/at most 1048576 bytes together/);
    expect(refusal({ ...base, path: "plan.md", bytes: MAX_RUN_DOCUMENTS_BYTES - 1 })).toBeNull();
  });

  it("lets an amendment keep a document by its latest revision without reading it again", async () => {
    const published = publishDocument(launched, { path: "plan.md", artifactId: "sha256:a2", bytes: 9, by: "run-1.build" }, "t2");
    if (!published.ok) throw new Error(published.reason);

    const result = await snapshotRunDocuments({
      requests: [
        { path: "plan.md", revision: 2, description: "The plan, edited" },
        { path: "notes.md", revision: 1, description: "Notes", appliesTo: ["build"] },
      ],
      current: published.revisions,
      worktreePath: worktree,
      store,
    });

    expect(result).toEqual({
      ok: true,
      documents: [
        { path: "plan.md", artifactId: "sha256:a2", bytes: 9, description: "The plan, edited", seen: 2 },
        { path: "notes.md", artifactId: "sha256:b", bytes: 1, description: "Notes", appliesTo: ["build"], seen: 1 },
      ],
    });
  });

  it("refuses to replace a seat's publication unless the declaration names it, and a named revision must be the latest", async () => {
    const published = publishDocument(launched, { path: "plan.md", artifactId: "sha256:a2", bytes: 9, by: "run-1.build" }, "t2");
    if (!published.ok) throw new Error(published.reason);
    const declare = (requests: Parameters<typeof snapshotRunDocuments>[0]["requests"]) =>
      snapshotRunDocuments({ requests, current: published.revisions, worktreePath: worktree, store });

    expect(
      await declare([
        { path: "plan.md", contents: "mine", description: "The plan" },
        { path: "notes.md", contents: "n", description: "Notes", revision: 2 },
      ]),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: ["documents", 0, "revision"],
          message: expect.stringMatching(/revision 2 was published by run-1\.build.*"revision": 2/),
        },
        { path: ["documents", 1, "revision"], message: expect.stringContaining("latest is revision 1") },
      ],
    });

    const replaced = await declare([
      { path: "plan.md", contents: "mine", description: "The plan", revision: 2 },
      { path: "notes.md", contents: "n", description: "Notes" },
    ]);
    expect(replaced.ok && replaced.documents.map((d) => [d.path, d.seen])).toEqual([
      ["plan.md", 2],
      ["notes.md", undefined],
    ]);
  });

  it("refuses a publication over a revision its publisher did not start from, unless the publisher made it", () => {
    const fromX = publishDocument(launched, { path: "plan.md", artifactId: "sha256:x", bytes: 1, by: "run-1.x", base: 1 }, "t2");
    if (!fromX.ok) throw new Error(fromX.reason);
    const refusal = (revisions: typeof launched, published: Parameters<typeof publishDocument>[1]) => {
      const result = publishDocument(revisions, published, "t3");
      return result.ok ? null : result.reason;
    };

    // Y started from revision 1 too: X's revision 2 is newer than what Y read.
    expect(refusal(fromX.revisions, { path: "plan.md", artifactId: "sha256:y", bytes: 1, by: "run-1.y", base: 1 })).toMatch(
      /plan\.md is at revision 2, published by run-1\.x after you started from revision 1/,
    );
    // X may revise its own revision.
    expect(refusal(fromX.revisions, { path: "plan.md", artifactId: "sha256:x2", bytes: 1, by: "run-1.x", base: 1 })).toBeNull();
    // A document another context published after Y started, which Y never read.
    const decisions = publishDocument(
      fromX.revisions,
      { path: "decisions.md", artifactId: "sha256:d", bytes: 1, by: "run-1.x", base: null, description: "Decisions" },
      "t3",
    );
    if (!decisions.ok) throw new Error(decisions.reason);
    expect(
      refusal(decisions.revisions, { path: "decisions.md", artifactId: "sha256:d2", bytes: 1, by: "run-1.y", base: null }),
    ).toMatch(/decisions\.md is at revision 1, published by run-1\.x after you started:/);
    // The owner amended it after X started.
    const amended = reviseDocuments(launched, [doc("plan.md", "sha256:o"), doc("notes.md", "sha256:b")], "amend", "t2");
    expect(refusal(amended, { path: "plan.md", artifactId: "sha256:x", bytes: 1, by: "run-1.x", base: 1 })).toMatch(
      /plan\.md is at revision 2, made by an amendment after you started from revision 1/,
    );
    // A context started before runs recorded what it froze is not checked.
    expect(refusal(fromX.revisions, { path: "plan.md", artifactId: "sha256:y", bytes: 1, by: "run-1.y" })).toBeNull();
  });

  it("refuses to keep a revision that is not the document's latest, or a document the run does not have", async () => {
    const result = await snapshotRunDocuments({
      requests: [
        { path: "plan.md", revision: 2, description: "The plan" },
        { path: "gone.md", revision: 1, description: "Gone" },
        { path: "notes.md", from: "notes.md", contents: "x", description: "Both" },
      ],
      current: launched,
      worktreePath: worktree,
      store,
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["documents", 0, "revision"], message: expect.stringContaining("latest is revision 1") },
        { path: ["documents", 1, "revision"], message: expect.stringContaining('no document "gone.md"') },
        { path: ["documents", 2], message: expect.stringContaining("exactly one of") },
      ],
    });
  });
});

describe("a file a seat publishes", () => {
  it("is frozen from inside the seat's working directory, and refused from outside it or over the size limit", async () => {
    await writeFile(path.join(worktree, "notes.md"), "Endpoints\n");
    await writeFile(path.join(outside, "secret.md"), "secret\n");
    await symlink(path.join(outside, "secret.md"), path.join(worktree, "linked.md"));
    await writeFile(path.join(worktree, "huge.md"), "x".repeat(262_145));

    const frozen = await snapshotDocumentFile({ worktreePath: worktree, file: "notes.md", store });
    expect(frozen).toEqual({ ok: true, path: "notes.md", artifactId: expect.stringMatching(/^sha256:/), bytes: 10 });
    if (frozen.ok) expect((await store.read(frozen.artifactId)).toString()).toBe("Endpoints\n");

    expect(await snapshotDocumentFile({ worktreePath: worktree, file: "linked.md", store })).toEqual({
      ok: false,
      message: expect.stringContaining("inside your working directory; it links outside it"),
    });
    expect(await snapshotDocumentFile({ worktreePath: worktree, file: "huge.md", store })).toEqual({
      ok: false,
      message: expect.stringContaining("at most 262144 bytes"),
    });
  });
});

describe("the paths a seat publishes from", () => {
  it("takes an absolute path inside the working directory or a ./ form as the same relative path, and refuses a frozen copy", async () => {
    await mkdir(path.join(worktree, "docs"), { recursive: true });
    await writeFile(path.join(worktree, "docs/api.md"), "GET\n");
    await mkdir(path.join(worktree, ".cc/run-docs/run-1.a"), { recursive: true });
    await writeFile(path.join(worktree, ".cc/run-docs/run-1.a/plan.md"), "copy\n");
    await writeFile(path.join(outside, "x.md"), "outside\n");

    for (const file of [path.join(worktree, "docs/api.md"), "./docs/api.md", "docs//api.md"])
      expect(await snapshotDocumentFile({ worktreePath: worktree, file, store }), file).toMatchObject({
        ok: true,
        path: "docs/api.md",
      });
    expect(await snapshotDocumentFile({ worktreePath: worktree, file: "./.cc/run-docs/run-1.a/plan.md", store })).toEqual({
      ok: false,
      message: expect.stringContaining("is a frozen copy"),
    });
    expect(await snapshotDocumentFile({ worktreePath: worktree, file: path.join(outside, "x.md"), store })).toEqual({
      ok: false,
      message: expect.stringContaining("inside your working directory"),
    });
  });
});
