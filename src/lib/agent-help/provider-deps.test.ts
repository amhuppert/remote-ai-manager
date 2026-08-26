/**
 * Unit tests for the pure freshness-mapping helper behind the conversation
 * provider (docs/design/cc-cli/04 §4.3). The I/O wiring around it is thin
 * plumbing over already-tested primitives; the staleness rule is the real logic.
 */
import { describe, expect, it } from "vitest";

import { PROMPT_VERSION } from "@/lib/context-artifacts/generation";
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";

import { summarizeArtifacts } from "./provider-deps";

function row(overrides: Partial<ContextArtifactRow> = {}): ContextArtifactRow {
  return {
    id: "artifact-1",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/p",
    sessionName: "sess",
    conversationId: "conv-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 41,
    sourceHash: "hash",
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: {
      modelId: "claude-fable-5",
      parameters: { effort: "high" },
    },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    createdBy: "user",
    createdByConversationId: null,
    payload: {
      schemaVersion: 1,
      kind: "conversation_compaction",
      source: {
        projectName: "p",
        sessionName: "sess",
        conversationId: "conv-1",
        coveredStartSeq: 0,
        coveredEndSeq: 41,
        messageCount: 1,
        sourceHash: "hash",
      },
      agentBrief: "brief",
      currentState: {
        status: "implementation_in_progress",
        latestUserGoal: "goal",
        nextBestActions: [],
      },
      decisions: [],
      files: [],
      commands: [],
      openQuestions: [],
      blockers: [],
      omissions: { reasoningOmitted: false, largeToolOutputsElided: 0 },
      extras: {},
    },
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeArtifacts", () => {
  it("marks a conversation artifact stale when the transcript advanced past it", () => {
    expect(summarizeArtifacts([row({ coveredEndSeq: 41 })], 50)).toEqual([
      { kind: "conversation_compaction", stale: true, outdated: false },
    ]);
  });

  it("keeps a conversation artifact fresh when the transcript has not advanced", () => {
    expect(summarizeArtifacts([row({ coveredEndSeq: 41 })], 41)).toEqual([
      { kind: "conversation_compaction", stale: false, outdated: false },
    ]);
  });

  it("never marks a message artifact stale even past its covered range", () => {
    expect(
      summarizeArtifacts(
        [row({ kind: "message_compaction", coveredEndSeq: 7 })],
        99,
      ),
    ).toEqual([{ kind: "message_compaction", stale: false, outdated: false }]);
  });

  it("flags version drift as outdated", () => {
    expect(
      summarizeArtifacts([row({ promptVersion: "old-version" })], 0),
    ).toEqual([
      { kind: "conversation_compaction", stale: false, outdated: true },
    ]);
  });
});
