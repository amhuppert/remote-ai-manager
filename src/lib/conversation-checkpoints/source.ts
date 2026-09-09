/**
 * Checkpoint source capture: one immutable read of the original archive.
 *
 * The build reads the transcript ONCE, through a recorded raw JSONL boundary,
 * and everything downstream — generation, envelope reuse, and the frozen
 * payload's provenance — derives from that value. Queued messages are not in
 * the archive, so they fall outside the snapshot by construction, and a later
 * checkpoint captures the original history again through its own boundary
 * rather than inheriting an earlier checkpoint's summary.
 */

import { createHash } from "node:crypto";

import {
  isArtifactVersionCurrent,
  lastRenderedSeq,
  type CapturedTranscriptSource,
} from "@/lib/context-artifacts/envelope-generation";
import { PROMPT_VERSION } from "@/lib/context-artifacts/generation";
import { redactEnvelopeStrings } from "@/lib/context-artifacts/redaction";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import {
  NORMALIZER_VERSION,
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
} from "@/lib/conversations/transcript-render";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";

import type {
  CheckpointArtifactProvenance,
  CheckpointSourceBasis,
} from "./schemas";

/**
 * Bumped when the hash basis below changes shape. It is part of the basis, so
 * an old hash can never collide with a new one over the same archive.
 */
export const CHECKPOINT_SOURCE_HASH_VERSION = "1";

/**
 * The render the source hash describes. Fixed rather than configurable: the
 * hash claims "this exact normalized input", and a caller-varied option set
 * would make two builds over the same archive incomparable.
 *
 * `maxBytes` is deliberately unbounded rather than the model window. Generation
 * folds an oversized archive segment by segment and reads every one of them, so
 * a hash taken through the single-pass window would leave later segments —
 * and, for a lone oversize message, the tail the renderer elides inside it —
 * outside the basis. The pre-freeze recheck would then call a changed archive
 * unchanged. Under the window this render is byte-identical to the one
 * generation's single pass produces, so a reading artifact's hash stays
 * comparable.
 */
const CHECKPOINT_SOURCE_RENDER_OPTIONS = {
  includeTools: "summary",
  includeThinking: false,
  maxBytes: Number.MAX_SAFE_INTEGER,
} as const;

export interface CapturedCheckpointSource {
  /** The snapshot handed to generation, entries included. */
  captured: CapturedTranscriptSource;
  /** What the frozen payload records: the boundary and the versioned hash. */
  basis: CheckpointSourceBasis;
  /** The normalized, redacted text the hash is computed over. */
  normalizedMarkdown: string;
  /**
   * Bare digest of `normalizedMarkdown`, in the artifact service's own hash
   * form. Comparing a reading artifact's `sourceHash` needs the artifact's
   * hash, not the checkpoint's versioned basis.
   */
  markdownHash: string;
  totalMessages: number;
  /** First raw sequence in the snapshot; the coverage a full envelope claims. */
  firstSeq: number;
}

export interface CaptureCheckpointSourceDeps {
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
}

export interface CaptureCheckpointSourceInput {
  conversationId: string;
  transcriptPath: string | null;
}

export type EnvelopeReuseRefusal =
  | "no_artifact"
  | "incomplete"
  | "version_mismatch"
  | "coverage_mismatch"
  | "source_hash_mismatch";

export type EnvelopeReuseDecision =
  | {
      reusable: true;
      envelope: CompactionEnvelope;
      provenance: CheckpointArtifactProvenance;
    }
  | { reusable: false; reason: EnvelopeReuseRefusal };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export async function captureCheckpointSource(
  input: CaptureCheckpointSourceInput,
  deps: CaptureCheckpointSourceDeps,
): Promise<CapturedCheckpointSource> {
  const read = await deps.readEntries(input.transcriptPath);
  // Copied, not aliased: the caller's array may be a live cache the reader
  // appends to, and a build that re-read its own source would defeat the
  // whole point of a captured boundary.
  const entries = [...read.entries];
  const capturedThroughSeq = lastRenderedSeq(entries, read.maxSeq);

  const rendered = renderCompactTranscript(
    {
      conversationId: input.conversationId,
      entries,
      maxSeq: read.maxSeq,
    },
    renderOptionsSchema.parse(CHECKPOINT_SOURCE_RENDER_OPTIONS),
  );
  if (rendered.truncated) {
    // Unreachable with an unbounded budget; a truncated render would mean the
    // hash describes less than the archive, which is the one thing it may not
    // do, so it fails rather than freezing a basis that cannot detect change.
    throw new Error(
      `checkpoint source render truncated through seq ${capturedThroughSeq}`,
    );
  }
  const normalizedMarkdown = renderedTranscriptToMarkdown(
    redactEnvelopeStrings(rendered),
  );
  const markdownHash = sha256(normalizedMarkdown);

  return {
    captured: {
      conversationId: input.conversationId,
      entries,
      maxSeq: read.maxSeq,
      capturedThroughSeq,
    },
    basis: {
      capturedThroughSeq,
      sourceHash: sha256(
        JSON.stringify({
          hashVersion: CHECKPOINT_SOURCE_HASH_VERSION,
          normalizerVersion: NORMALIZER_VERSION,
          promptVersion: PROMPT_VERSION,
          envelopeSchemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
          renderOptions: CHECKPOINT_SOURCE_RENDER_OPTIONS,
          capturedThroughSeq,
          markdownHash,
        }),
      ),
    },
    normalizedMarkdown,
    markdownHash,
    totalMessages: rendered.totalMessages,
    firstSeq: entries[0]?.seq ?? 0,
  };
}

/**
 * Whether two captures describe the same archive. Checkpoint-maintenance
 * rechecks its source against this before freezing: a build that started
 * before a late turn landed must not freeze a payload that claims a boundary
 * the archive has already moved past.
 */
export function checkpointSourceBasisMatches(
  a: CheckpointSourceBasis,
  b: CheckpointSourceBasis,
): boolean {
  return (
    a.capturedThroughSeq === b.capturedThroughSeq &&
    a.sourceHash === b.sourceHash
  );
}

/**
 * Whether a completed reading artifact already describes exactly this captured
 * input. Anything less than an exact match — a fold whose recorded hash covers
 * only its last window, a stale generator version, coverage short of the
 * boundary — regenerates from the snapshot, because a partial match would make
 * an earlier summary the effective source of a later checkpoint.
 */
export function decideEnvelopeReuse(
  row: ContextArtifactRow | null,
  source: CapturedCheckpointSource,
): EnvelopeReuseDecision {
  if (row === null || row.kind !== "conversation_compaction") {
    return { reusable: false, reason: "no_artifact" };
  }
  if (row.status !== "complete" || row.payload === null) {
    return { reusable: false, reason: "incomplete" };
  }
  if (!isArtifactVersionCurrent(row)) {
    return { reusable: false, reason: "version_mismatch" };
  }
  if (
    row.coveredStartSeq !== source.firstSeq ||
    row.coveredEndSeq !== source.basis.capturedThroughSeq
  ) {
    return { reusable: false, reason: "coverage_mismatch" };
  }
  if (row.sourceHash !== source.markdownHash) {
    return { reusable: false, reason: "source_hash_mismatch" };
  }
  return {
    reusable: true,
    envelope: row.payload,
    provenance: {
      artifactId: row.id,
      artifactSourceHash: row.sourceHash,
    },
  };
}
