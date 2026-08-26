import type { CompactionEnvelope } from "@/lib/context-artifacts/schemas";
import type {
  ContextArtifactDetail,
  ContextArtifactListItem,
} from "@/lib/context-artifacts/queries";
import type { SourceRef } from "@/lib/conversations/schemas";
import type { CompactionProvenance } from "./CompactionEnvelopeView";

/**
 * Deterministic envelope fixtures shared by the context-artifact component
 * tests and Storybook stories.
 */

export function buildSourceRef(
  messageIndex: number,
  overrides: Partial<SourceRef> = {},
): SourceRef {
  return {
    messageIndex,
    messageId: `msg-${messageIndex}`,
    seqStart: messageIndex * 3,
    seqEnd: messageIndex * 3 + 2,
    quote: `verbatim excerpt from message ${messageIndex}`,
    ...overrides,
  };
}

/** Every section populated; long agentBrief; refs on every item. */
export function buildMaximalEnvelope(): CompactionEnvelope {
  return {
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "command-center",
      sessionName: "csm-compaction-demo",
      conversationId: "conv-fixture-1",
      coveredStartSeq: 0,
      coveredEndSeq: 421,
      messageCount: 57,
      sourceHash: "sha256:0f5d1a9c",
    },
    agentBrief:
      // Opening paragraph is intentionally free of inline markdown so it renders
      // as one contiguous <p> — a consumer test matches this phrase by substring.
      "Implemented the context_artifacts storage layer end-to-end: entry-level " +
      "transcript reader with exact seq coordinates, the deterministic " +
      "renderCompactTranscript normalizer shared by the read endpoint and the " +
      "compaction pre-strip, and the SQLite-backed repo behind two partial " +
      "unique indexes.\n\n" +
      "### What shipped\n\n" +
      "The generation service runs the full pipeline — render, redact, prompt, " +
      "structured task run, schema parse with one retry — on a **synthetic " +
      "transient actor lane** so the target conversation's actor is never " +
      "touched. Envelopes persist through `repo.ts` behind the partial unique " +
      "indexes.\n\n" +
      "### Verification\n\n" +
      "- All `136` repo tests plus the `44` service/route tests pass\n" +
      "- `bun run typecheck` and `bun run lint` are clean\n" +
      "- Remaining risk: live verification of the SSE reconciliation path under " +
      "concurrent triggers from `cctl` and the UI",
    currentState: {
      status: "implementation_in_progress",
      latestUserGoal:
        "Ship the per-message compaction UX with an inline envelope viewer",
      nextBestActions: [
        "Wire the MessageActions compact button to useCompactMutation",
        "Live-verify SSE reconciliation with a real compaction run",
        "Add the conversation-level status chip",
      ],
    },
    decisions: [
      {
        statement: "Store envelopes in SQLite, not sidecar files.",
        rationale:
          "Envelopes are a few KB; one durable store, one backup path.",
        status: "accepted",
        sourceRefs: [buildSourceRef(5), buildSourceRef(9)],
      },
      {
        statement: "Reuse the jobs table for compaction runs.",
        rationale: "Jobs are session-shaped; project scope has no sessionName.",
        status: "superseded",
        sourceRefs: [buildSourceRef(12)],
      },
    ],
    files: [
      {
        path: "src/lib/context-artifacts/repo.ts",
        role: "created",
        details: "factory repo over the shared db handle",
        sourceRefs: [buildSourceRef(6)],
      },
      {
        path: "src/lib/state-store/state-db.ts",
        role: "modified",
        details: "context_artifacts floor DDL + partial unique indexes",
        sourceRefs: [buildSourceRef(7)],
      },
    ],
    commands: [
      {
        command: "bunx vitest run src/lib/context-artifacts",
        outcome: "succeeded",
        summary: "full domain suite green after the guard retry fix",
        sourceRefs: [buildSourceRef(14)],
      },
      {
        command: "bun run typecheck",
        outcome: "failed",
        summary: "stale AgentAuth fakes missing validateOptionalToken",
        sourceRefs: [buildSourceRef(15)],
      },
    ],
    openQuestions: [
      {
        text: "Should the status chip live in SessionInfoStrip or the info popover?",
        sourceRefs: [buildSourceRef(21)],
      },
    ],
    blockers: [
      {
        text: "Waiting on live verification before merge.",
        sourceRefs: [buildSourceRef(33)],
      },
    ],
    omissions: {
      reasoningOmitted: true,
      largeToolOutputsElided: 12,
    },
    extras: { timeline: "not yet graduated" },
  };
}

/** Sparse message-compaction envelope: prose + state only, no anchored arrays. */
export function buildMinimalEnvelope(): CompactionEnvelope {
  return {
    schemaVersion: 1,
    kind: "message_compaction",
    source: {
      projectName: "command-center",
      sessionName: "csm-compaction-demo",
      conversationId: "conv-fixture-1",
      coveredStartSeq: 88,
      coveredEndSeq: 91,
      messageCount: 1,
      sourceHash: "sha256:77aa21",
    },
    agentBrief:
      "Single tool-heavy assistant turn: ran the failing suite, isolated the " +
      "flaky matcher registration, and re-ran clean.",
    currentState: {
      status: "resolved",
      latestUserGoal: "Explain the intermittent matcher failure",
      nextBestActions: ["Nothing pending for this message"],
    },
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
    omissions: {
      reasoningOmitted: false,
      largeToolOutputsElided: 0,
    },
    extras: {},
  };
}

/** A complete message-compaction list row (no payload — list responses omit it). */
export function buildArtifactListItem(
  overrides: Partial<ContextArtifactListItem> = {},
): ContextArtifactListItem {
  return {
    id: "art-1",
    kind: "message_compaction",
    scope: "session",
    projectPath: "/abs/p1",
    sessionName: "s1",
    conversationId: "c1",
    messageId: "msg-3",
    messageIndex: 3,
    coveredStartSeq: 88,
    coveredEndSeq: 91,
    sourceHash: "sha256:77aa21",
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
    schemaVersion: 1,
    promptVersion: "cp-1",
    normalizerVersion: "nv-1",
    createdBy: "user",
    createdByConversationId: null,
    createdAt: "2026-07-05T10:30:00.000Z",
    updatedAt: "2026-07-05T10:31:00.000Z",
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
    ...overrides,
  };
}

/** The same row as a GET-one response: payload included. */
export function buildArtifactDetail(
  overrides: Partial<ContextArtifactDetail> = {},
): ContextArtifactDetail {
  return {
    ...buildArtifactListItem(),
    payload: buildMinimalEnvelope(),
    ...overrides,
  };
}

export function buildProvenance(
  overrides: Partial<CompactionProvenance> = {},
): CompactionProvenance {
  return {
    backend: "claude",
    modelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
    promptVersion: "cp-1",
    normalizerVersion: "nv-1",
    schemaVersion: 1,
    createdBy: "user",
    createdAt: "2026-07-05T10:30:00.000Z",
    ...overrides,
  };
}
