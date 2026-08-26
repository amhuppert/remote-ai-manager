import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "./project-conversations-repo";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo-a";

let db: Db;
let repo: ProjectConversationsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createProjectConversationsRepo(db);
});

afterEach(() => {
  db.close();
});

/**
 * Build a project conversation with EVERY introspectable persisted key path
 * populated to a distinctive non-default value, so the schema-driven
 * durability harness can prove no field is dropped on write or reset to its
 * default on read.
 *
 * Mirrors the session-conversations maximal fixture, plus the two PLC-only
 * persisted fields this table owns: `open` (set to `false`, the value the
 * write path would otherwise coerce away if it were dropped) and
 * `spawnedSessionIds` (populated back-link list).
 */
function buildMaximalProjectConversation(): ConversationState {
  return conversationStateSchema.parse({
    id: "plc-maximal",
    scope: "project",
    name: "Maximal project conversation",
    nameOrigin: "auto",
    transcriptPath: "/tmp/transcripts/plc-maximal.jsonl",
    status: "running",
    promptCount: 42,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-02-15T08:09:10Z",
    source: "imported",
    summary: "A maximal durability fixture",
    archived: true,
    open: false,
    spawnedSessionIds: ["spawned-session-1", "spawned-session-2"],
    creationRequestId: "create-request-9f3c",
    totalCostUsd: 12.34,
    totalDurationMs: 56_789,
    totalTurns: 11,
    pendingQuestionId: "q-maximal",
    pendingQuestions: [
      {
        id: "q-maximal-item",
        question: "Continue with the maximal plan?",
        header: "Plan confirmation",
        context:
          "Implications: this **proceeds** with the `maximal` plan.\n- ships sooner\n- less review",
        options: [
          {
            label: "yes",
            description: "proceed as planned",
            recommended: true,
            tradeoff: { pro: "ships now", con: "less review headroom" },
          },
          { label: "no", description: "abort the plan", recommended: false },
        ],
        multiSelect: true,
        required: false,
        allowNote: false,
      },
    ],
    pendingPromptText: "draft prompt text that should round-trip verbatim",
    unread: true,
    forkedFrom: {
      sourceConversationId: "parent-conv",
      messageIndex: 7,
      sourceBackend: "codex",
      sourceBackendRef: { backend: "codex", ref: "src-thread" },
      forkLocator: "msg-7",
      forkMode: "synthetic",
      // Non-default so the column is proven durable. The combination is not a
      // real fork state — a maximal fixture is a shape, not a scenario.
      forkPending: true,
    },
    role: "validator",
    // activeTurnSource is intentionally omitted (see fieldPolicies): it is
    // transient runtime state with no persistence column.
    contextTokens: 12_345,
    contextWindowMax: 200_000,
    debugMode: {
      active: true,
      debugSessionId: "debug-session-plc-maximal",
      recording: true,
      logFilePath: "/tmp/debug/plc-maximal.log",
      enteredAt: "2026-01-15T00:00:00Z",
      hypotheses: [
        {
          id: "h1",
          description: "suspected race condition",
          instrumentationPlan: "add timing probes around the lock acquisition",
        },
      ],
      reproductionSteps: ["run the prompt twice in quick succession"],
      fixSummary: "serialized the write queue",
      verificationSteps: ["confirm no duplicate rows after concurrent upserts"],
      instructionsDelivered: true,
      phase: "awaiting_verification",
      lastTurnFailed: true,
      cleanupVerificationAttempt: 2,
    },
    agentBackend: "codex",
    backendRef: { backend: "codex", ref: "thread-maximal" },
    mcpOverrides: {
      servers: {
        stripe: {
          enabled: true,
          tools: {
            charge: { enabled: false },
          },
        },
      },
    },
    mcpRuntime: {
      lastAppliedConfigHash: "hash-applied",
      pendingConfigHash: "hash-pending",
      pendingServerKeys: ["stripe"],
      lastApplyDisposition: "deferred_to_next_turn",
      lastApplyError: "transport handshake timed out",
    },
    agentCapabilityOverrides: {
      cascades: {
        "codex-skills": {
          items: {
            "review-pr": { enabled: false },
          },
        },
      },
    },
    agentCapabilitiesRuntime: {
      cascades: {
        "codex-skills": {
          appliedHash: "cap-applied",
          pendingHash: "cap-pending",
          pendingItemIds: ["review-pr"],
          lastApplyStatus: "staged-next-turn",
          lastApplyError: "discovery refresh required",
        },
      },
    },
    pendingQueue: [
      {
        id: "q-maximal",
        content: [
          { type: "text", text: "queued follow-up that should round-trip" },
          {
            type: "document_feedback",
            items: [
              {
                docPath: ".kiro/specs/x/design.md",
                path: ".kiro/specs/x/design.md",
                headingLabel: "Prompt pipeline extension",
                line: 42,
                quote: "the exact quoted passage that must round-trip",
                note: "queued feedback note that must round-trip",
              },
            ],
          },
        ],
        status: "delivering",
        enqueuedAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:05:00Z",
        deliveryStartedAt: "2026-03-01T00:04:00Z",
        deliveredAt: "2026-03-01T00:06:00Z",
        cancelledAt: "2026-03-01T00:07:00Z",
        failedAt: "2026-03-01T00:08:00Z",
        deliveryAttemptId: "attempt-maximal",
        attemptCount: 3,
        error: "transient delivery error that should round-trip",
        metadata: {
          kind: "question_answers",
          questionBatchId: "q_maximal",
        },
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    ],
    lastSeenAlignmentVersion: 7,
    pendingAgentNotices: [
      "agent notice that must round-trip (lost background tasks)",
    ],
    profileSnapshot: {
      tier: "global",
      id: "maximal-profile",
      name: "Maximal profile",
      revision: 4,
      sourceContentHash: `sha256:${"1".repeat(64)}`,
      instructions:
        "Private profile instructions that must round-trip verbatim",
      renderedInstructionBlock:
        "<agent-profile>\nPrivate profile instructions that must round-trip verbatim\n</agent-profile>",
      resolvedInstructionHash: `sha256:${"2".repeat(64)}`,
    },
    profileLockedAt: "2026-02-01T09:00:00.000Z",
    owner: {
      kind: "collaboration",
      workflowId: "wf-maximal",
      attemptEpoch: 3,
    },
    turnGeneration: 11,
  });
}

describe("project-conversations-repo durability contract", () => {
  it("round-trips every persisted project-conversation key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "project-conversations",
      schema: conversationStateSchema,
      buildMaximalFixture: buildMaximalProjectConversation,
      persist: (fixture) => {
        repo.upsert(PROJECT_PATH, fixture);
        return fixture;
      },
      reload: (expected) => repo.findByKey(PROJECT_PATH, expected.id),
      fieldPolicies: {
        // `activeTurnSource` is derived from the in-flight XState conversation
        // machine's `activeTurn` (see deriveActiveTurnSource in
        // workflows/conversation/manager.ts). It is transient turn state with
        // no `active_turn_source` column: it is never written and is correctly
        // reset to null on reload. Not a serialization gap — genuinely durable
        // state never includes it.
        activeTurnSource: "not-persisted",
      },
    });
  });
});

describe("project-conversations-repo profile snapshot durability", () => {
  it("reloads the full private snapshot from SQLite byte-for-byte", () => {
    const fixture = buildMaximalProjectConversation();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, fixture.id);
    expect(out?.profileSnapshot).toEqual(fixture.profileSnapshot);
    expect(out?.profileSnapshot?.renderedInstructionBlock).toBe(
      fixture.profileSnapshot?.renderedInstructionBlock,
    );
    expect(out?.profileLockedAt).toBe(fixture.profileLockedAt);
  });

  it("reloads the no-op default's snapshot as a record, not as an absence", () => {
    // Same rule as the session repo: an empty stored block is a value, and a
    // project conversation under the named default keeps its provenance.
    const fixture = conversationStateSchema.parse({
      id: "noop-plc",
      scope: "project",
      transcriptPath: null,
      status: "awaiting",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      profileSnapshot: NO_OP_SNAPSHOT_FIXTURE,
      profileLockedAt: "2026-02-01T09:00:00.000Z",
    });
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, fixture.id);

    expect(out?.profileSnapshot).not.toBeNull();
    expect(out?.profileSnapshot?.renderedInstructionBlock).toBe("");
    expect(out?.profileSnapshot?.resolvedInstructionHash).toBe(
      computeContentHash(""),
    );
    expect(out?.profileSnapshot?.id).toBe(STANDARD_AGENT_PROFILE_ID);
    expect(out?.profileSnapshot?.name).toBe("Standard Agent");
  });

  it("reloads a pre-feature row (null columns) as the legacy no-profile shape", () => {
    const legacy = conversationStateSchema.parse({
      id: "legacy-plc",
      scope: "project",
      transcriptPath: null,
      status: "awaiting",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    });
    repo.upsert(PROJECT_PATH, legacy);
    db.prepare(
      `UPDATE project_conversations
       SET profile_snapshot = NULL, profile_locked_at = NULL
       WHERE id = ?`,
    ).run(legacy.id);

    const out = repo.findByKey(PROJECT_PATH, legacy.id);
    expect(out).not.toBeNull();
    expect(out?.profileSnapshot).toBeNull();
    expect(out?.profileLockedAt).toBeNull();
  });
});
