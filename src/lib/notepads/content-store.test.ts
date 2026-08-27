import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Logging is an import-time-side-effect infrastructure module — the narrow
// vi.mock exception the testing boundaries carve out, matching the ticket
// content-store test it clones.
vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNotepadContentStore,
  NotepadContentError,
  sanitizeSnapshotBasename,
  type NotepadContentStore,
} from "./content-store";

const NOTEPAD_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_NOTEPAD_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_IMAGE_ID = "44444444-4444-4444-8444-444444444444";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let base: string;
let contentRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(path.join(tmpdir(), "cc-notepad-content-"));
  contentRoot = path.join(base, "notepad-content");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeStore(
  listNotepadIdsForProject: (projectPath: string) => Promise<string[]> = () =>
    Promise.resolve([]),
): NotepadContentStore {
  return createNotepadContentStore({ contentRoot, listNotepadIdsForProject });
}

async function expectContentError(
  promise: Promise<unknown>,
  code: "unsafe_key" | "snapshot_not_found",
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(NotepadContentError);
  expect((error as NotepadContentError).code).toBe(code);
}

describe("sanitizeSnapshotBasename", () => {
  it("keeps ordinary image names and reduces paths to their basename", () => {
    expect(sanitizeSnapshotBasename("screen shot 2.png")).toBe(
      "screen shot 2.png",
    );
    expect(sanitizeSnapshotBasename("../../nested/evil.png")).toBe("evil.png");
  });

  it("falls back for names that sanitize to nothing", () => {
    expect(sanitizeSnapshotBasename("..")).toBe("image");
    expect(sanitizeSnapshotBasename("")).toBe("image");
  });

  it("stays idempotent when truncation would split a surrogate pair", () => {
    const name = `x${"𠀀".repeat(80)}`;
    const once = sanitizeSnapshotBasename(name);
    expect(sanitizeSnapshotBasename(once)).toBe(once);
  });
});

describe("capture", () => {
  it("keeps captured image bytes readable after the source is gone", async () => {
    const store = makeStore();
    const sourcePath = path.join(base, "pasted.png");
    await writeFile(sourcePath, PNG_BYTES);

    const snapshot = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "pasted.png",
      bytes: await readFile(sourcePath),
    });
    await rm(sourcePath);

    const roundTripped = await store.read(snapshot.snapshotKey);
    expect(Buffer.from(roundTripped).equals(PNG_BYTES)).toBe(true);
  });

  it("returns the id-addressed key, sanitized name, size, and sha256", async () => {
    const store = makeStore();

    const snapshot = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "../escape attempt/shot.png",
      bytes: PNG_BYTES,
    });

    expect(snapshot.snapshotKey).toBe(`${NOTEPAD_ID}/${IMAGE_ID}/shot.png`);
    expect(snapshot.fileName).toBe("shot.png");
    expect(snapshot.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores inside the content root and leaves no temp files behind", async () => {
    const store = makeStore();
    await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "shot.png",
      bytes: PNG_BYTES,
    });

    const imageDir = path.join(contentRoot, NOTEPAD_ID, IMAGE_ID);
    expect(await readdir(imageDir)).toEqual(["shot.png"]);
  });

  it("rejects unsafe id segments", async () => {
    const store = makeStore();
    await expectContentError(
      store.capture({
        notepadId: "../escape",
        imageId: IMAGE_ID,
        fileName: "shot.png",
        bytes: PNG_BYTES,
      }),
      "unsafe_key",
    );
    await expectContentError(
      store.capture({
        notepadId: NOTEPAD_ID,
        imageId: "..",
        fileName: "shot.png",
        bytes: PNG_BYTES,
      }),
      "unsafe_key",
    );
  });
});

describe("read", () => {
  it("throws snapshot_not_found for a missing snapshot", async () => {
    const store = makeStore();
    await expectContentError(
      store.read(`${NOTEPAD_ID}/${IMAGE_ID}/missing.png`),
      "snapshot_not_found",
    );
  });

  it.each([
    ["../../outside.png", "traversal segments"],
    [`${NOTEPAD_ID}/${IMAGE_ID}/../escape.png`, "dot-dot name"],
    [`${NOTEPAD_ID}/${IMAGE_ID}`, "too few segments"],
    [`${NOTEPAD_ID}/${IMAGE_ID}/a/b.png`, "too many segments"],
    [`${NOTEPAD_ID}/${IMAGE_ID}/.hidden`, "unsanitized name"],
    [`/etc/${IMAGE_ID}/passwd`, "absolute-ish segment"],
  ])("rejects unsafe key %s (%s)", async (key) => {
    const store = makeStore();
    await expectContentError(store.read(key), "unsafe_key");
  });

  it("cannot read files outside the content root", async () => {
    await writeFile(path.join(base, "secret.txt"), "secret");
    const store = makeStore();

    await expectContentError(store.read("../secret.txt"), "unsafe_key");
    await expectContentError(
      store.read(`${NOTEPAD_ID}/../../secret.txt`),
      "unsafe_key",
    );
  });
});

describe("delete", () => {
  it("removes the snapshot and prunes the empty notepad directory", async () => {
    const store = makeStore();
    const snapshot = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "gone.png",
      bytes: PNG_BYTES,
    });

    await store.delete(snapshot.snapshotKey);

    await expectContentError(
      store.read(snapshot.snapshotKey),
      "snapshot_not_found",
    );
    await expect(
      stat(path.join(contentRoot, NOTEPAD_ID)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps sibling images of the same notepad", async () => {
    const store = makeStore();
    const first = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "first.png",
      bytes: Buffer.from("first"),
    });
    const second = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: OTHER_IMAGE_ID,
      fileName: "second.png",
      bytes: Buffer.from("second"),
    });

    await store.delete(first.snapshotKey);

    expect(Buffer.from(await store.read(second.snapshotKey)).toString()).toBe(
      "second",
    );
  });

  it("is idempotent", async () => {
    const store = makeStore();
    const key = `${NOTEPAD_ID}/${IMAGE_ID}/never-existed.png`;
    await expect(store.delete(key)).resolves.toBeUndefined();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("rejects unsafe keys", async () => {
    const store = makeStore();
    await expectContentError(store.delete("../../outside.png"), "unsafe_key");
  });
});

describe("deleteNotepad", () => {
  it("removes every image of the notepad and keeps other notepads", async () => {
    const store = makeStore();
    const mine = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "mine.png",
      bytes: Buffer.from("mine"),
    });
    const alsoMine = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: OTHER_IMAGE_ID,
      fileName: "also-mine.png",
      bytes: Buffer.from("also mine"),
    });
    const other = await store.capture({
      notepadId: OTHER_NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "other.png",
      bytes: Buffer.from("other"),
    });

    await store.deleteNotepad(NOTEPAD_ID);

    await expectContentError(
      store.read(mine.snapshotKey),
      "snapshot_not_found",
    );
    await expectContentError(
      store.read(alsoMine.snapshotKey),
      "snapshot_not_found",
    );
    await expect(store.read(other.snapshotKey)).resolves.toBeTruthy();
  });

  it("is a no-op for a notepad that never held an image", async () => {
    const store = makeStore();
    await expect(store.deleteNotepad(NOTEPAD_ID)).resolves.toBeUndefined();
  });

  it("rejects unsafe notepad ids", async () => {
    const store = makeStore();
    await expectContentError(store.deleteNotepad(".."), "unsafe_key");
    await expectContentError(store.deleteNotepad("a/b"), "unsafe_key");
  });
});

describe("deleteProject", () => {
  it("removes the content of every notepad the lookup reports", async () => {
    const store = makeStore(() =>
      Promise.resolve([NOTEPAD_ID, OTHER_NOTEPAD_ID]),
    );
    const first = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "a.png",
      bytes: Buffer.from("a"),
    });
    const second = await store.capture({
      notepadId: OTHER_NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "b.png",
      bytes: Buffer.from("b"),
    });

    await store.deleteProject("/projects/demo");

    await expectContentError(
      store.read(first.snapshotKey),
      "snapshot_not_found",
    );
    await expectContentError(
      store.read(second.snapshotKey),
      "snapshot_not_found",
    );
  });

  it("uses ids captured before the project cascade without querying deleted rows", async () => {
    const lookup = vi.fn(() => Promise.reject(new Error("rows deleted")));
    const store = makeStore(lookup);
    const snapshot = await store.capture({
      notepadId: NOTEPAD_ID,
      imageId: IMAGE_ID,
      fileName: "captured.png",
      bytes: PNG_BYTES,
    });

    await store.deleteProject("/projects/demo", [NOTEPAD_ID]);

    expect(lookup).not.toHaveBeenCalled();
    await expectContentError(
      store.read(snapshot.snapshotKey),
      "snapshot_not_found",
    );
  });

  it("is best-effort: unsafe ids and missing directories never throw", async () => {
    const store = makeStore(() =>
      Promise.resolve(["../escape", "never-captured-notepad"]),
    );
    await expect(
      store.deleteProject("/projects/demo"),
    ).resolves.toBeUndefined();
  });

  it("degrades a failing lookup to a warning naming the orphaned path", async () => {
    const store = makeStore(() => Promise.reject(new Error("db closed")));

    await expect(
      store.deleteProject("/projects/demo"),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "content.project_cleanup_lookup_failed",
      expect.objectContaining({
        projectPath: "/projects/demo",
        orphanPathKey: "notepad-content",
        error: "db closed",
      }),
    );
  });
});
