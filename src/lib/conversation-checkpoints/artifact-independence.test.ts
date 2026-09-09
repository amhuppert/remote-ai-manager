import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Infrastructure-only mock (module-level createLogger side effect); every
// service and generation dependency is injected.
vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createCompactionService,
  type CompactionService,
} from "@/lib/context-artifacts/service";
import {
  createContextArtifactsRepo,
  type ContextArtifactsRepo,
} from "@/lib/context-artifacts/repo";
import {
  compactionEnvelopeSchema,
  type CompactionEnvelope,
} from "@/lib/context-artifacts/schemas";
import { compactionConfigSchema } from "@/lib/config/schemas";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import type { CheckpointConversationGateway } from "./continuation";
import { generateCheckpoint } from "./generation";
import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
} from "./repo";
import type { CheckpointScopeKey } from "./schemas";
import { captureCheckpointSource } from "./source";

type Db = InstanceType<typeof Database>;

const KEY: CheckpointScopeKey = {
  scope: "session",
  projectPath: "/projects/alpha",
  sessionName: "csm-alpha",
  conversationId: "conv-session",
};

const USAGE = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

function text(
  seq: number,
  role: "user" | "assistant",
  body: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text: body }],
  };
}

const ENTRIES: TranscriptEntryWithSeq[] = [
  text(0, "user", "compact this conversation"),
  text(1, "assistant", "reading the archive"),
  text(2, "user", "then checkpoint it"),
  text(3, "assistant", "freezing the seed"),
];

const WORKING_STATE = {
  objective: {
    text: "checkpoint the conversation",
    sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
  },
  latestRequest: {
    text: "then checkpoint it",
    sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
  },
  outstandingRequests: [
    {
      text: "freeze the seed",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
  constraints: [],
  decisions: [
    {
      statement: "freeze the rendered bytes",
      status: "accepted",
      rationale: "the injected string must be exact",
      sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
    },
  ],
  failedApproaches: [],
  openQuestions: [],
  blockers: [],
  nextActions: [
    {
      text: "retire the runtime",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
};

function envelopeFromPrompt(prompt: string) {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("prompt has no source metadata section");
  const jsonStart = start + marker.length;
  const meta = JSON.parse(
    prompt.slice(jsonStart, prompt.indexOf("\n```", jsonStart)),
  ) as { kind: string; source: CompactionEnvelope["source"] };
  const envelope = compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: meta.kind,
    source: meta.source,
    agentBrief: `brief ${briefCounter}`,
    currentState: {
      status: "in_progress",
      latestUserGoal: "checkpoint the conversation",
      nextBestActions: ["freeze the seed"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
  return {
    ...envelope,
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
  };
}

function recordingContinuation(): CheckpointConversationGateway & {
  cleared: CheckpointScopeKey[];
} {
  const state = {
    cleared: [] as CheckpointScopeKey[],
    exists(): boolean {
      return true;
    },
    find(): null {
      return null;
    },
    clearBackendRef(key: CheckpointScopeKey): boolean {
      state.cleared.push(key);
      return true;
    },
  };
  return state;
}

let db: Db;
let artifacts: ContextArtifactsRepo;
let checkpoints: ConversationCheckpointsRepo;
let continuation: ReturnType<typeof recordingContinuation>;
let service: CompactionService;
let briefCounter: number;

const executeTaskRun = async (
  input: ExecuteWorkflowTaskRunInput,
): Promise<TaskRunResult> => ({
  kind: "structured",
  structuredOutput: input.prompt.includes("checkpoint working state")
    ? WORKING_STATE
    : envelopeFromPrompt(input.prompt),
  text: "",
  usage: USAGE,
  backendRef: null,
  continuationDisposition: "retain",
});

beforeEach(() => {
  vi.clearAllMocks();
  briefCounter = 1;
  db = _createTestDb({ inMemory: true });
  artifacts = createContextArtifactsRepo(db);
  continuation = recordingContinuation();
  checkpoints = createConversationCheckpointsRepo(
    db,
    createWriteQueue(),
    continuation,
  );
  service = createCompactionService({
    executeTaskRun,
    readEntries: async () => ({ entries: ENTRIES, maxSeq: 3 }),
    repo: artifacts,
    resolveConfig: async () => compactionConfigSchema.parse({}),
    broadcast: () => {},
    now: () => "2026-07-05T00:00:00Z",
  });
});

afterEach(() => {
  db.close();
});

async function triggerArtifact(force: boolean) {
  const result = await service.trigger({
    kind: "conversation_compaction",
    scope: "session",
    projectPath: KEY.projectPath,
    projectName: "alpha",
    sessionName: KEY.sessionName,
    conversationId: KEY.conversationId,
    transcriptPath: "/tmp/conv-session.jsonl",
    createdBy: "user",
    createdByConversationId: null,
    trigger: "test",
    ...(force ? { force: true } : {}),
  });
  if (result.outcome !== "started") {
    throw new Error(`expected started, got ${result.outcome}`);
  }
  return result.completion;
}

describe("checkpoint payloads are independent of the reading artifact", () => {
  it("keeps frozen seed bytes fixed when the rolling artifact is regenerated", async () => {
    const artifactRow = await triggerArtifact(false);
    expect(artifactRow.status).toBe("complete");

    const source = await captureCheckpointSource(
      {
        conversationId: KEY.conversationId,
        transcriptPath: "/tmp/conv-session.jsonl",
      },
      { readEntries: async () => ({ entries: ENTRIES, maxSeq: 3 }) },
    );

    const admitted = await checkpoints.admitOperation({
      key: KEY,
      requestId: "11111111-1111-4111-8111-111111111111",
      sourceBasis: source.basis,
      priorBackendRef: "provider-session-1",
      requestedAt: "2026-07-05T00:00:01Z",
    });
    if (!admitted.ok) throw new Error(admitted.refusal.reason);

    const generated = await generateCheckpoint(
      {
        identity: {
          conversationId: KEY.conversationId,
          checkpointId: admitted.value.operation.id,
          ordinal: admitted.value.operation.ordinal,
          scope: "session",
        },
        source,
        existingArtifact: artifacts.findById(artifactRow.id),
        lane: {
          address: {
            projectPath: KEY.projectPath,
            target: sessionConversationTarget(
              "alpha",
              "csm-alpha",
              `checkpoint-${admitted.value.operation.id}`,
            ),
          },
          worktreePath: "/projects/alpha/.worktrees/csm-alpha",
          backend: "claude",
        },
        config: compactionConfigSchema.parse({}),
        createdAt: "2026-07-05T00:00:02Z",
      },
      { executeTaskRun },
    );
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const frozen = await checkpoints.freezePayload({
      key: KEY,
      operationId: admitted.value.operation.id,
      payload: generated.payload,
      at: "2026-07-05T00:00:03Z",
    });
    if (!frozen.ok) throw new Error(frozen.refusal.reason);
    expect(frozen.value.phase).toBe("retiring");

    // Refresh the rolling reading artifact: a different envelope, same source.
    briefCounter = 2;
    const refreshed = await triggerArtifact(true);
    expect(refreshed.payload?.agentBrief).toBe("brief 2");
    expect(artifacts.findById(artifactRow.id)?.payload?.agentBrief).toBe(
      "brief 2",
    );

    const reloaded = await checkpoints.getPayload(
      KEY,
      admitted.value.operation.id,
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded?.seedText).toBe(generated.payload.seedText);
    expect(reloaded?.seedSha256).toBe(generated.payload.seedSha256);
    expect(reloaded?.sectionBytes).toEqual(generated.payload.sectionBytes);
    expect(reloaded?.sourceBasis).toEqual(source.basis);
    expect(reloaded?.artifactProvenance).toEqual({
      artifactId: artifactRow.id,
      artifactSourceHash: source.markdownHash,
    });

    // Generating or refreshing an artifact retires nothing and moves no phase.
    expect(continuation.cleared).toEqual([]);
    const operation = await checkpoints.getOperation(
      KEY,
      admitted.value.operation.id,
    );
    expect(operation?.phase).toBe("retiring");
  });
});
