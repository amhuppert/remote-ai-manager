import { describe, it, expect, beforeEach } from "vitest";

import {
  captureCheckpointSource,
  checkpointSourceBasisMatches,
  decideEnvelopeReuse,
  type CapturedCheckpointSource,
} from "./source";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  compactionEnvelopeSchema,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import { PROMPT_VERSION } from "@/lib/context-artifacts/generation";
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";

function makeEntry(
  seq: number,
  role: "user" | "assistant",
  text: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text }],
  };
}

function entriesResult(
  entries: TranscriptEntryWithSeq[],
): TranscriptEntriesResult {
  return { entries, maxSeq: entries[entries.length - 1]?.seq ?? 0 };
}

const BASE_ENTRIES = [
  makeEntry(0, "user", "ship the checkpoint builder"),
  makeEntry(1, "assistant", "starting with the budget module"),
  makeEntry(2, "user", "keep the archive recoverable"),
  makeEntry(3, "assistant", "captured through the raw boundary"),
];

let reads: (string | null)[];

function deps(result: TranscriptEntriesResult) {
  return {
    readEntries: async (transcriptPath: string | null) => {
      reads.push(transcriptPath);
      return result;
    },
  };
}

async function capture(
  entries: TranscriptEntryWithSeq[] = BASE_ENTRIES,
): Promise<CapturedCheckpointSource> {
  return captureCheckpointSource(
    { conversationId: "convo-1", transcriptPath: "/tmp/convo-1.jsonl" },
    deps(entriesResult(entries)),
  );
}

function completeRow(
  source: CapturedCheckpointSource,
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  return {
    id: "artifact-1",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/home/projects/proj",
    sessionName: "sess",
    conversationId: "convo-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: source.firstSeq,
    coveredEndSeq: source.basis.capturedThroughSeq,
    sourceHash: source.markdownHash,
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    createdBy: "user",
    createdByConversationId: null,
    payload: makeEnvelope(),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEnvelope(): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "convo-1",
      coveredStartSeq: 0,
      coveredEndSeq: 3,
      messageCount: 4,
      sourceHash: "hash",
    },
    agentBrief: "brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "goal",
      nextBestActions: ["next"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
}

beforeEach(() => {
  reads = [];
});

describe("captureCheckpointSource", () => {
  it("reads the archive once and records the raw boundary it read through", async () => {
    const source = await capture();

    expect(reads).toEqual(["/tmp/convo-1.jsonl"]);
    expect(source.basis.capturedThroughSeq).toBe(3);
    expect(source.captured.capturedThroughSeq).toBe(3);
    expect(source.captured.maxSeq).toBe(3);
    expect(source.captured.conversationId).toBe("convo-1");
    expect(source.firstSeq).toBe(0);
    expect(source.totalMessages).toBe(4);
    expect(source.basis.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("snapshots the entries so a later archive append cannot change the build", async () => {
    const entries = [...BASE_ENTRIES];
    const source = await captureCheckpointSource(
      { conversationId: "convo-1", transcriptPath: "/tmp/convo-1.jsonl" },
      deps(entriesResult(entries)),
    );
    entries.push(makeEntry(4, "user", "a message appended later"));

    expect(source.captured.entries).toHaveLength(4);
    expect(source.normalizedMarkdown).not.toContain("appended later");
  });

  it("redacts the normalized input it hashes and hands to generation", async () => {
    const source = await capture([
      ...BASE_ENTRIES,
      makeEntry(4, "user", "api_key = sk-abcdefghijklmnopqrstuvwxyz012345"),
    ]);

    expect(source.normalizedMarkdown).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(source.normalizedMarkdown).toContain("REDACTED");
  });

  it("hashes the same archive identically and a longer archive differently", async () => {
    const first = await capture();
    const second = await capture();
    const longer = await capture([
      ...BASE_ENTRIES,
      makeEntry(4, "user", "one more turn"),
    ]);

    expect(second.basis.sourceHash).toBe(first.basis.sourceHash);
    expect(longer.basis.sourceHash).not.toBe(first.basis.sourceHash);
    expect(longer.basis.capturedThroughSeq).toBe(4);
  });

  it("binds the versions into the recorded hash, so it is not a bare content digest", async () => {
    const source = await capture();
    expect(source.basis.sourceHash).not.toBe(source.markdownHash);
  });
});

describe("decideEnvelopeReuse", () => {
  it("reuses a complete envelope with exact coverage, hash, and versions", async () => {
    const source = await capture();
    const decision = decideEnvelopeReuse(completeRow(source), source);

    expect(decision).toMatchObject({
      reusable: true,
      provenance: {
        artifactId: "artifact-1",
        artifactSourceHash: source.markdownHash,
      },
    });
  });

  it("refuses a folded or partial envelope whose coverage stops short of the boundary", async () => {
    const source = await capture();
    const decision = decideEnvelopeReuse(
      completeRow(source, {
        coveredEndSeq: source.basis.capturedThroughSeq - 1,
      }),
      source,
    );

    expect(decision).toEqual({ reusable: false, reason: "coverage_mismatch" });
  });

  it("refuses an envelope whose source hash describes a different rendering", async () => {
    const source = await capture();
    const decision = decideEnvelopeReuse(
      completeRow(source, { sourceHash: "a".repeat(64) }),
      source,
    );

    expect(decision).toEqual({
      reusable: false,
      reason: "source_hash_mismatch",
    });
  });

  it("refuses an envelope produced by an older prompt, normalizer, or schema", async () => {
    const source = await capture();

    expect(
      decideEnvelopeReuse(completeRow(source, { promptVersion: "0" }), source),
    ).toEqual({ reusable: false, reason: "version_mismatch" });
    expect(
      decideEnvelopeReuse(
        completeRow(source, { normalizerVersion: "0" }),
        source,
      ),
    ).toEqual({ reusable: false, reason: "version_mismatch" });
    expect(
      decideEnvelopeReuse(completeRow(source, { schemaVersion: 0 }), source),
    ).toEqual({ reusable: false, reason: "version_mismatch" });
  });

  it("refuses a pending, failed, or payload-less artifact and a missing one", async () => {
    const source = await capture();

    expect(
      decideEnvelopeReuse(
        completeRow(source, { status: "pending", payload: null }),
        source,
      ),
    ).toEqual({ reusable: false, reason: "incomplete" });
    expect(
      decideEnvelopeReuse(completeRow(source, { payload: null }), source),
    ).toEqual({ reusable: false, reason: "incomplete" });
    expect(decideEnvelopeReuse(null, source)).toEqual({
      reusable: false,
      reason: "no_artifact",
    });
  });
});

describe("checkpointSourceBasisMatches", () => {
  it("accepts an unchanged archive and refuses one that moved on", async () => {
    const before = await capture();
    const same = await capture();
    const after = await capture([
      ...BASE_ENTRIES,
      makeEntry(4, "user", "late turn"),
    ]);

    expect(checkpointSourceBasisMatches(before.basis, same.basis)).toBe(true);
    expect(checkpointSourceBasisMatches(before.basis, after.basis)).toBe(false);
  });

  it("refuses a same-boundary capture whose normalized content differs", async () => {
    const before = await capture();
    expect(
      checkpointSourceBasisMatches(before.basis, {
        capturedThroughSeq: before.basis.capturedThroughSeq,
        sourceHash: "a".repeat(64),
      }),
    ).toBe(false);
  });
});

describe("captureCheckpointSource — complete generation input", () => {
  /**
   * Generation folds an oversized archive segment by segment, so the captured
   * hash has to describe every segment. A hash taken through the single-pass
   * model window would leave later segments unhashed: the source could change
   * where the fold still reads it, and the pre-freeze basis recheck would call
   * the changed archive unchanged.
   */
  it("hashes archive content past the single-pass model window", async () => {
    const bulk = (marker: string): string => `${marker}${"x".repeat(200_000)}`;
    const before = [
      makeEntry(0, "user", bulk("a")),
      makeEntry(1, "assistant", bulk("b")),
      makeEntry(2, "user", bulk("c")),
      makeEntry(3, "assistant", bulk("d")),
    ];
    const after = [
      ...before.slice(0, 3),
      makeEntry(3, "assistant", bulk("CHANGED")),
    ];

    const first = await capture(before);
    const second = await capture(after);

    expect(second.basis.capturedThroughSeq).toBe(
      first.basis.capturedThroughSeq,
    );
    expect(second.markdownHash).not.toBe(first.markdownHash);
    expect(second.basis.sourceHash).not.toBe(first.basis.sourceHash);
    expect(checkpointSourceBasisMatches(first.basis, second.basis)).toBe(false);
  });
});
