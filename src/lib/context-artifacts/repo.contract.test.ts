import { afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import type { SourceRef } from "@/lib/conversations/schemas";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";
import {
  contextArtifactRowSchema,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";

type Db = InstanceType<typeof Database>;

let db: Db;
let repo: ContextArtifactsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  repo = createContextArtifactsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("context-artifacts repo durability contract", () => {
  it("round-trips every persisted context-artifact key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "context-artifacts",
      schema: contextArtifactRowSchema,
      buildMaximalFixture: buildMaximalContextArtifact,
      persist: (fixture) => {
        repo.upsert(fixture);
        return fixture;
      },
      reload: (expected) => repo.findById(expected.id),
      fieldPolicies: {},
    });
  });
});

function buildSourceRef(seq: number): SourceRef {
  return {
    messageIndex: seq + 1,
    messageId: `entry-${seq}`,
    seqStart: seq,
    seqEnd: seq + 2,
    quote: `verbatim excerpt ${seq}`,
  };
}

/**
 * Every array populated, every optional/defaulted field set to a distinctive
 * non-default value: decision status "superseded" (default is "accepted"),
 * extras non-empty (default {}), quote present on every sourceRef.
 */
function buildMaximalEnvelope(): CompactionEnvelope {
  return {
    schemaVersion: 1,
    kind: "message_compaction",
    source: {
      projectName: "maximal-project",
      sessionName: "csm-maximal-session",
      conversationId: "conv-maximal",
      coveredStartSeq: 4,
      coveredEndSeq: 17,
      messageCount: 6,
      sourceHash: "sha256:feedbeef",
    },
    agentBrief:
      "Implemented the artifact repo behind the two partial-unique indexes; suite green.",
    currentState: {
      status: "implementation_in_progress",
      latestUserGoal: "Persist compaction envelopes durably",
      nextBestActions: ["wire the delete paths", "run the contract suite"],
    },
    decisions: [
      {
        statement: "Store payloads in SQLite rather than sidecar files.",
        rationale: "Envelopes are a few KB; one durable store.",
        status: "superseded",
        sourceRefs: [buildSourceRef(5), buildSourceRef(9)],
      },
    ],
    files: [
      {
        path: "src/lib/context-artifacts/repo.ts",
        role: "created",
        details: "factory repo over the shared db handle",
        sourceRefs: [buildSourceRef(6)],
      },
    ],
    commands: [
      {
        command: "bunx vitest run src/lib/context-artifacts",
        outcome: "mixed",
        summary: "one red test pinned the upsert branching",
        sourceRefs: [buildSourceRef(7)],
      },
    ],
    openQuestions: [
      {
        text: "Should findByScope filter to project-scope-only rows?",
        sourceRefs: [buildSourceRef(8)],
      },
    ],
    blockers: [
      {
        text: "Waiting on the normalizer version constant.",
        sourceRefs: [buildSourceRef(10)],
      },
    ],
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 3 },
    extras: { timeline: ["scaffolded", "tested"], assumptionCount: 2 },
  };
}

/**
 * Every column of the context_artifacts row non-null: a message_compaction
 * artifact is the only kind that legitimately fills messageId/messageIndex,
 * and agent-created rows fill createdByConversationId. `error` carries a
 * retained transient-failure note alongside a complete payload.
 */
function buildMaximalContextArtifact(): ContextArtifactRow {
  return contextArtifactRowSchema.parse({
    id: "artifact-maximal-1",
    kind: "message_compaction",
    scope: "session",
    projectPath: "/projects/maximal",
    sessionName: "csm-maximal-session",
    conversationId: "conv-maximal",
    messageId: "msg-11",
    messageIndex: 11,
    coveredStartSeq: 4,
    coveredEndSeq: 17,
    sourceHash: "sha256:feedbeef",
    status: "complete",
    error: "attempt 1 timed out; retried",
    modelProvider: "codex",
    model: "gpt-5.5-codex",
    effort: "high",
    schemaVersion: 1,
    promptVersion: "compaction-prompt-v3",
    normalizerVersion: "normalizer-v2",
    createdBy: "agent",
    createdByConversationId: "conv-orchestrator",
    payload: buildMaximalEnvelope(),
    createdAt: "2026-07-05T09:30:00.000Z",
    updatedAt: "2026-07-05T09:45:00.000Z",
  } satisfies ContextArtifactRow);
}
