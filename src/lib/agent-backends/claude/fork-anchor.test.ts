import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyTranscriptUpTo,
  getTranscriptPath,
  readTranscriptLineClassifications,
  type CopyTranscriptMode,
  type TranscriptEntry,
} from "@/lib/prompt/transcript";
import { selectClaudeForkAnchor } from "./fork-anchor";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "cc-claude-fork-anchor-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function user(text: string): TranscriptEntry {
  return {
    timestamp: "t",
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistant(text: string, uuid?: string): TranscriptEntry {
  return {
    timestamp: "t",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text }],
    ...(uuid !== undefined ? { uuid } : {}),
  };
}

function notice(text: string): TranscriptEntry {
  return {
    timestamp: "t",
    type: "notice",
    role: "notice",
    content: [{ type: "text", text }],
  };
}

function nonVisible(type: string): TranscriptEntry {
  return { timestamp: "t", type, raw: { subtype: type } };
}

/**
 * The anchor for a fork of `entries` at `messageIndex`, read from the snapshot
 * the fork service produces: an inclusive copy for an assistant target, an
 * exclusive copy for a user target.
 */
async function anchorForFork(
  entries: TranscriptEntry[],
  messageIndex: number,
  mode: CopyTranscriptMode,
): Promise<string | null> {
  const sourcePath = await getTranscriptPath("source", configDir);
  await writeFile(
    sourcePath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8",
  );
  await copyTranscriptUpTo({
    sourceTranscriptPath: sourcePath,
    targetConversationId: "snapshot",
    upToMessageIndex: messageIndex,
    mode,
    configDir,
  });
  const snapshotPath = await getTranscriptPath("snapshot", configDir);
  return selectClaudeForkAnchor(
    await readTranscriptLineClassifications(snapshotPath),
  );
}

describe("selectClaudeForkAnchor — user fork (exclusive snapshot)", () => {
  it("anchors on the last assistant message before the forked user message", async () => {
    const anchor = await anchorForFork(
      [
        user("Hello"),
        assistant("Hi there", "uuid-asst-1"),
        user("Question"),
        assistant("Answer", "uuid-asst-2"),
      ],
      2,
      "exclusive",
    );
    expect(anchor).toBe("uuid-asst-1");
  });

  it("anchors on the last line of a multi-line assistant message", async () => {
    const anchor = await anchorForFork(
      [
        user("Hello"),
        assistant("Part 1", "uuid-part-1"),
        assistant("Part 2", "uuid-part-2"),
        assistant("Part 3", "uuid-part-3"),
        user("Follow-up"),
      ],
      2,
      "exclusive",
    );
    expect(anchor).toBe("uuid-part-3");
  });

  it("has no anchor for a transcript written before anchors were stored", async () => {
    const anchor = await anchorForFork(
      [user("Hello"), assistant("Hi"), user("Question")],
      2,
      "exclusive",
    );
    expect(anchor).toBeNull();
  });

  it("ignores non-visible lines when locating the preceding assistant", async () => {
    const anchor = await anchorForFork(
      [
        user("Hello"),
        nonVisible("system"),
        assistant("Hi", "uuid-1"),
        nonVisible("result"),
        user("Question"),
      ],
      2,
      "exclusive",
    );
    expect(anchor).toBe("uuid-1");
  });

  it("anchors past a trailing user or notice message on the assistant before it", async () => {
    const afterNotice = await anchorForFork(
      [
        user("Hello"),
        assistant("Hi", "uuid-1"),
        notice("/merge completed"),
        user("Next"),
      ],
      3,
      "exclusive",
    );
    expect(afterNotice).toBe("uuid-1");
  });

  it("has no anchor when the message before the fork is an assistant message without an anchor", async () => {
    // Cutting at an earlier anchor would drop a turn the copied history shows
    // (e.g. checkpoint-capture output recorded without a message uuid).
    const anchor = await anchorForFork(
      [
        user("Hello"),
        assistant("Hi", "uuid-1"),
        notice("checkpoint capture"),
        assistant("captured working state"),
        user("Next"),
      ],
      4,
      "exclusive",
    );
    expect(anchor).toBeNull();
  });
});

describe("selectClaudeForkAnchor — assistant fork (inclusive snapshot)", () => {
  it("anchors on the forked assistant message itself", async () => {
    const anchor = await anchorForFork(
      [user("Hello"), assistant("Hi there", "uuid-asst-1")],
      1,
      "inclusive",
    );
    expect(anchor).toBe("uuid-asst-1");
  });

  it("anchors on the last line of the forked merged assistant message", async () => {
    const anchor = await anchorForFork(
      [
        user("Hello"),
        assistant("Part 1", "uuid-part-1"),
        assistant("Part 2", "uuid-part-2"),
        user("Follow-up"),
      ],
      1,
      "inclusive",
    );
    expect(anchor).toBe("uuid-part-2");
  });

  it("has no anchor when the forked assistant message carries none, even if an earlier one does", async () => {
    const anchor = await anchorForFork(
      [
        user("Hello"),
        assistant("Hi", "uuid-1"),
        user("More"),
        assistant("legacy reply"),
      ],
      3,
      "inclusive",
    );
    expect(anchor).toBeNull();
  });
});
