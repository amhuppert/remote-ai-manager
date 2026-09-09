import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  createHistoryImageService,
  type HistoryImageResult,
} from "./history-image-service";
import {
  readContainedTranscriptImageBytes,
  transcriptImagesRoot,
} from "@/lib/images/transcript-images";
import {
  readTranscriptEntriesWithSeq,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptReadCacheForTesting,
} from "@/lib/prompt/transcript";

const TEST_DIR = path.join(
  "/tmp",
  `cc-history-image-${process.pid}-${Date.now()}`,
);
const CONFIG_DIR = path.join(TEST_DIR, "config");
const CONVERSATION_ID = "conv-image";

/** A real 1x1 PNG and a real 1x1 GIF, so the assertions hash actual bytes. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const service = createHistoryImageService({
  readTranscriptEntries: readTranscriptEntriesWithSeq,
  readImageBytes: (imagePath) =>
    readContainedTranscriptImageBytes(
      imagePath,
      transcriptImagesRoot(CONFIG_DIR),
    ),
});

let transcriptPath = "";
let storedImagePath = "";
let missingImagePath = "";
let outsidePath = "";
/** A file INSIDE the root whose own inode lives outside it. */
let symlinkedFilePath = "";
/** A file inside the root only lexically: an ancestor directory escapes. */
let symlinkedDirFilePath = "";

async function writeArchive(): Promise<void> {
  transcriptPath = path.join(TEST_DIR, "images.jsonl");
  const lines = [
    JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [
        { type: "text", text: "stored screenshot" },
        {
          type: "image_marker",
          index: 1,
          mediaType: "image/png",
          imagePath: storedImagePath,
        },
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: storedImagePath,
        },
      ],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:01Z",
      type: "user",
      role: "user",
      content: [
        { type: "image", mediaType: "image/gif", base64Data: GIF_BASE64 },
      ],
    }),
    JSON.stringify({ type: "system", timestamp: "t", raw: { init: true } }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:03Z",
      type: "assistant",
      role: "assistant",
      content: [
        { type: "text", text: "no image here" },
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: missingImagePath,
        },
        { type: "image_ref", mediaType: "image/png", imagePath: outsidePath },
        {
          type: "image_ref",
          mediaType: "text/html",
          imagePath: storedImagePath,
        },
      ],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:04Z",
      type: "user",
      role: "user",
      content: [
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: symlinkedFilePath,
        },
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: symlinkedDirFilePath,
        },
        {
          type: "image_marker",
          index: 9,
          mediaType: "image/png",
          imagePath: symlinkedFilePath,
        },
      ],
    }),
  ];
  await writeFile(transcriptPath, lines.join("\n") + "\n", "utf-8");
}

async function getImage(
  seq: number,
  contentBlockIndex: number,
): Promise<HistoryImageResult> {
  _resetTranscriptEntriesCacheForTesting();
  return service.getImage({
    conversationId: CONVERSATION_ID,
    transcriptPath,
    seq,
    contentBlockIndex,
  });
}

describe("archive image recovery", () => {
  beforeEach(async () => {
    _resetTranscriptEntriesCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    const imagesDir = path.join(
      transcriptImagesRoot(CONFIG_DIR),
      CONVERSATION_ID,
    );
    await mkdir(imagesDir, { recursive: true });
    storedImagePath = path.join(imagesDir, "1.png");
    missingImagePath = path.join(imagesDir, "2.png");
    await writeFile(storedImagePath, Buffer.from(PNG_BASE64, "base64"));
    outsidePath = path.join(TEST_DIR, "outside.png");
    await writeFile(outsidePath, Buffer.from(PNG_BASE64, "base64"));

    // Two escapes that pass a lexical containment check: a symlinked file
    // inside the root, and a real file reached through a symlinked ancestor.
    symlinkedFilePath = path.join(imagesDir, "sneaky.png");
    await symlink(outsidePath, symlinkedFilePath);
    const outsideDir = path.join(TEST_DIR, "outside-dir");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      path.join(outsideDir, "1.png"),
      Buffer.from(PNG_BASE64, "base64"),
    );
    await symlink(
      outsideDir,
      path.join(transcriptImagesRoot(CONFIG_DIR), "escaped"),
    );
    symlinkedDirFilePath = path.join(
      transcriptImagesRoot(CONFIG_DIR),
      "escaped",
      "1.png",
    );

    await writeArchive();
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("recovers stored bytes for an externalized image", async () => {
    const result = await getImage(0, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const original = await readFile(storedImagePath);
    expect(sha256(result.image.bytes)).toBe(sha256(original));
    expect(result.image.sha256).toBe(sha256(original));
    expect(result.image.byteLength).toBe(original.byteLength);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.handle).toEqual({
      conversationId: CONVERSATION_ID,
      seq: 0,
      contentBlockIndex: 2,
      mediaType: "image/png",
      storage: "external",
      command: `cctl conversation image get ${CONVERSATION_ID} 0 2`,
    });
  });

  it("returns the image-bearing handle when the display marker is addressed", async () => {
    const result = await getImage(0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One displayed image: the marker resolves to its reference's index.
    expect(result.image.handle.contentBlockIndex).toBe(2);
    expect(sha256(result.image.bytes)).toBe(
      sha256(await readFile(storedImagePath)),
    );
  });

  it("decodes an inline image on demand", async () => {
    const result = await getImage(1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sha256(result.image.bytes)).toBe(
      sha256(Buffer.from(GIF_BASE64, "base64")),
    );
    expect(result.image.mediaType).toBe("image/gif");
    expect(result.image.handle.storage).toBe("inline");
  });

  it("keeps the original handle when the stored asset is gone", async () => {
    const result = await getImage(3, 1);
    expect(result).toMatchObject({
      ok: false,
      code: "asset_unavailable",
      requested: {
        conversationId: CONVERSATION_ID,
        seq: 3,
        contentBlockIndex: 1,
      },
    });
    if (result.ok) return;
    expect(result.handle).toMatchObject({
      seq: 3,
      contentBlockIndex: 1,
      storage: "external",
    });
  });

  it("refuses a path that escapes the archive image root", async () => {
    const result = await getImage(3, 2);
    expect(result).toMatchObject({ ok: false, code: "image_outside_archive" });
  });

  it("refuses a symlink inside the root that resolves outside it", async () => {
    // Lexical containment holds; the inode is the outside file. Serving it
    // would turn an archived coordinate into an arbitrary file read.
    const result = await getImage(4, 0);
    expect(result).toMatchObject({ ok: false, code: "image_outside_archive" });
    if (result.ok) return;
    expect(result.handle).toMatchObject({ seq: 4, contentBlockIndex: 0 });
  });

  it("refuses a path reaching outside through a symlinked ancestor", async () => {
    expect(await getImage(4, 1)).toMatchObject({
      ok: false,
      code: "image_outside_archive",
    });
  });

  it("refuses an escaping unpaired marker on the same terms", async () => {
    expect(await getImage(4, 2)).toMatchObject({
      ok: false,
      code: "image_outside_archive",
    });
  });

  it("refuses a media type that is not a servable image", async () => {
    const result = await getImage(3, 3);
    expect(result).toMatchObject({ ok: false, code: "unsupported_media_type" });
  });

  it("refuses a block that is not an image", async () => {
    const result = await getImage(3, 0);
    expect(result).toMatchObject({ ok: false, code: "not_an_image_block" });
  });

  it("refuses a content block index the entry does not have", async () => {
    expect(await getImage(1, 9)).toMatchObject({
      ok: false,
      code: "block_not_found",
    });
    expect(await getImage(1, -1)).toMatchObject({
      ok: false,
      code: "block_not_found",
    });
  });

  it("identifies unsupported and absent sequences distinctly", async () => {
    expect(await getImage(2, 0)).toMatchObject({
      ok: false,
      code: "entry_unsupported",
    });
    expect(await getImage(99, 0)).toMatchObject({
      ok: false,
      code: "entry_not_found",
    });
  });

  it("never writes, copies, or renumbers an asset", async () => {
    const imagesDir = path.join(
      transcriptImagesRoot(CONFIG_DIR),
      CONVERSATION_ID,
    );
    const before = await readdir(imagesDir);
    const beforeStat = await stat(storedImagePath);
    const archiveBefore = sha256(await readFile(transcriptPath));

    await getImage(0, 2);
    await getImage(0, 1);
    await getImage(1, 0);
    await getImage(3, 1);

    expect(await readdir(imagesDir)).toEqual(before);
    expect((await stat(storedImagePath)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(sha256(await readFile(transcriptPath))).toBe(archiveBefore);
  });

  it("keeps handles and bytes stable across repeated checkpoints", async () => {
    const cycle = async () => {
      const stored = await getImage(0, 2);
      const inline = await getImage(1, 0);
      if (!stored.ok || !inline.ok) throw new Error("expected both images");
      return [
        { handle: stored.image.handle, hash: stored.image.sha256 },
        { handle: inline.image.handle, hash: inline.image.sha256 },
      ];
    };
    const first = await cycle();
    expect(await cycle()).toEqual(first);
    expect(await cycle()).toEqual(first);
  });
});
