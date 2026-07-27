import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeAlignmentHash } from "./render";
import {
  ALIGNMENT_SNAPSHOT_DIR,
  CharterSnapshotConflictError,
  alignmentSnapshotPath,
  createCharterSnapshotWriter,
} from "./snapshot";

const CHARTER = "## Mission\nFreeze me exactly as I am.";
/**
 * Byte-different from CHARTER but the same Alignment version: the hash
 * normalizes line endings, so a content hash alone cannot prove which bytes a
 * snapshot holds.
 */
const CHARTER_CRLF = CHARTER.replace(/\n/g, "\r\n");

describe("createCharterSnapshotWriter", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(path.join(tmpdir(), "cc-align-snapshot-"));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  const absolutePathFor = (contentHash: string) =>
    path.join(worktreePath, alignmentSnapshotPath(contentHash));

  const seedSnapshot = async (contentHash: string, contents: string) => {
    await mkdir(path.dirname(absolutePathFor(contentHash)), {
      recursive: true,
    });
    await writeFile(absolutePathFor(contentHash), contents, "utf-8");
  };

  it("materializes the full charter at a hash-addressed worktree path", async () => {
    const writer = createCharterSnapshotWriter();
    const contentHash = computeAlignmentHash(CHARTER);

    const result = await writer.write({
      worktreePath,
      contentHash,
      content: CHARTER,
    });

    expect(result.filePath).toBe(`${ALIGNMENT_SNAPSHOT_DIR}/${contentHash}.md`);
    expect(result.created).toBe(true);
    expect(await readFile(absolutePathFor(contentHash), "utf-8")).toBe(CHARTER);
  });

  it("publishes atomically, leaving no partial or temporary file behind", async () => {
    const writer = createCharterSnapshotWriter();
    const contentHash = computeAlignmentHash(CHARTER);

    await writer.write({ worktreePath, contentHash, content: CHARTER });

    // The snapshot directory holds the published snapshot and nothing else:
    // the final path is never the write target, so it never holds partial bytes.
    expect(
      await readdir(path.join(worktreePath, ALIGNMENT_SNAPSHOT_DIR)),
    ).toEqual([`${contentHash}.md`]);
  });

  it("is idempotent: a repeat write of the same snapshot leaves the bytes alone", async () => {
    const writer = createCharterSnapshotWriter();
    const contentHash = computeAlignmentHash(CHARTER);

    const first = await writer.write({
      worktreePath,
      contentHash,
      content: CHARTER,
    });
    const second = await writer.write({
      worktreePath,
      contentHash,
      content: CHARTER,
    });

    expect(second.filePath).toBe(first.filePath);
    expect(second.created).toBe(false);
    expect(await readFile(absolutePathFor(contentHash), "utf-8")).toBe(CHARTER);
  });

  it("fails closed when an existing snapshot for the same hash holds different bytes", async () => {
    const contentHash = computeAlignmentHash(CHARTER);
    // The hash normalizes whitespace, so a byte-different charter legitimately
    // addresses the same file. Reporting success here would hand out a pointer
    // to bytes that are not the captured charter.
    expect(computeAlignmentHash(CHARTER_CRLF)).toBe(contentHash);
    await seedSnapshot(contentHash, CHARTER);

    const writer = createCharterSnapshotWriter();

    await expect(
      writer.write({ worktreePath, contentHash, content: CHARTER_CRLF }),
    ).rejects.toBeInstanceOf(CharterSnapshotConflictError);
    // The existing snapshot is still whatever an earlier capture froze.
    expect(await readFile(absolutePathFor(contentHash), "utf-8")).toBe(CHARTER);
  });

  it("never overwrites an existing hash-addressed file", async () => {
    const contentHash = computeAlignmentHash(CHARTER);
    const sentinel = "SENTINEL: these bytes are already frozen";
    await seedSnapshot(contentHash, sentinel);

    const writer = createCharterSnapshotWriter();

    await expect(
      writer.write({
        worktreePath,
        contentHash,
        content: "DIFFERENT: bytes that must never land",
      }),
    ).rejects.toBeInstanceOf(CharterSnapshotConflictError);
    expect(await readFile(absolutePathFor(contentHash), "utf-8")).toBe(
      sentinel,
    );
  });

  it("verifies the published bytes when another writer wins the race", async () => {
    const contentHash = computeAlignmentHash(CHARTER);
    let raced = false;
    const writer = createCharterSnapshotWriter({
      // Stand in for a concurrent writer that published between the existence
      // check and this one's publication attempt.
      publishExclusive: async (absolutePath, contents) => {
        raced = true;
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, contents, "utf-8");
        return false;
      },
    });

    const result = await writer.write({
      worktreePath,
      contentHash,
      content: CHARTER,
    });

    expect(raced).toBe(true);
    expect(result.created).toBe(false);
    expect(await readFile(absolutePathFor(contentHash), "utf-8")).toBe(CHARTER);
  });

  it("fails closed when the winner of the race published different bytes", async () => {
    const contentHash = computeAlignmentHash(CHARTER);
    const writer = createCharterSnapshotWriter({
      publishExclusive: async (absolutePath) => {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, CHARTER_CRLF, "utf-8");
        return false;
      },
    });

    await expect(
      writer.write({ worktreePath, contentHash, content: CHARTER }),
    ).rejects.toBeInstanceOf(CharterSnapshotConflictError);
  });

  it("rejects a content hash that is not addressable as a file name", async () => {
    const writer = createCharterSnapshotWriter();

    await expect(
      writer.write({
        worktreePath,
        contentHash: "../../escape",
        content: CHARTER,
      }),
    ).rejects.toThrow(/content hash/i);
  });

  it("propagates a write failure rather than reporting a snapshot that does not exist", async () => {
    const failure = new Error("disk full");
    const writer = createCharterSnapshotWriter({
      publishExclusive: async () => {
        throw failure;
      },
    });

    await expect(
      writer.write({
        worktreePath,
        contentHash: computeAlignmentHash(CHARTER),
        content: CHARTER,
      }),
    ).rejects.toBe(failure);
  });
});
