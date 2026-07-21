import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Infrastructure-only mock (module-level createLogger side effect); all
// service dependencies are injected through the factory.
vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

import {
  COMPACTION_MODEL_BUDGET_BYTES,
  createCompactionService,
  type CompactionService,
  type TriggerCompactionInput,
} from "./service";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";
import {
  compactionEnvelopeSchema,
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";
import { PROMPT_VERSION } from "./generation";
import { deriveFreshness } from "./freshness";
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import {
  compactionConfigSchema,
  type CompactionConfig,
} from "@/lib/config/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { SSEEvent } from "@/lib/api/sse-events";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";

const USAGE = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

function structuredResult(output: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: output,
    text: "",
    usage: USAGE,
    backendRef: null,
    continuationDisposition: "retain",
  };
}

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

const ENTRIES: TranscriptEntriesResult = {
  entries: [
    makeEntry(0, "user", "first question"),
    makeEntry(1, "assistant", "first answer"),
    makeEntry(2, "user", "second question"),
    makeEntry(3, "assistant", "second answer"),
  ],
  maxSeq: 3,
};

/** Extract the `{ kind, source }` block the prompt tells the model to copy. */
function extractSourceMeta(prompt: string): {
  kind: "message_compaction" | "conversation_compaction";
  source: CompactionEnvelope["source"];
} {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("prompt has no source metadata section");
  const jsonStart = start + marker.length;
  const jsonEnd = prompt.indexOf("\n```", jsonStart);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd)) as {
    kind: "message_compaction" | "conversation_compaction";
    source: CompactionEnvelope["source"];
  };
}

/** Build a schema+guard-valid envelope echoing the prompt's source metadata. */
function envelopeFromPrompt(
  prompt: string,
  extra: Partial<CompactionEnvelope> = {},
) {
  const meta = extractSourceMeta(prompt);
  const envelope = compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: meta.kind,
    source: meta.source,
    agentBrief: "dense handoff brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "goal",
      nextBestActions: ["next"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
    ...extra,
  });

  const outputRef = (
    ref: CompactionEnvelope["decisions"][number]["sourceRefs"][number],
  ) => ({
    ...ref,
    quote: ref.quote ?? null,
  });
  return {
    ...envelope,
    decisions: envelope.decisions.map((decision) => ({
      ...decision,
      rationale: decision.rationale ?? null,
      sourceRefs: decision.sourceRefs.map(outputRef),
    })),
    files: envelope.files.map((file) => ({
      ...file,
      details: file.details ?? null,
      sourceRefs: file.sourceRefs.map(outputRef),
    })),
    commands: envelope.commands.map((command) => ({
      ...command,
      summary: command.summary ?? null,
      sourceRefs: command.sourceRefs.map(outputRef),
    })),
    openQuestions: envelope.openQuestions.map((question) => ({
      ...question,
      sourceRefs: question.sourceRefs.map(outputRef),
    })),
    blockers: envelope.blockers.map((blocker) => ({
      ...blocker,
      sourceRefs: blocker.sourceRefs.map(outputRef),
    })),
  };
}

function makeTriggerInput(
  overrides: Partial<TriggerCompactionInput> = {},
): TriggerCompactionInput {
  return {
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/home/projects/proj",
    projectName: "proj",
    sessionName: "sess",
    conversationId: "convo-1",
    transcriptPath: "/tmp/convo-1.jsonl",
    createdBy: "user",
    createdByConversationId: null,
    trigger: "test",
    ...overrides,
  };
}

function makePreviousEnvelope(
  overrides: Partial<CompactionEnvelope> = {},
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "proj",
      sessionName: "sess",
      conversationId: "convo-1",
      coveredStartSeq: 0,
      coveredEndSeq: 1,
      messageCount: 2,
      sourceHash: "previous-hash",
    },
    agentBrief: "old brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "old goal",
      nextBestActions: ["old next"],
    },
    decisions: [
      {
        statement: "use sqlite",
        status: "accepted",
        sourceRefs: [
          { messageIndex: 0, messageId: "entry-0", seqStart: 0, seqEnd: 0 },
        ],
      },
    ],
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
    ...overrides,
  });
}

function makeCompleteRow(
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  return {
    id: "existing-artifact",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/home/projects/proj",
    sessionName: "sess",
    conversationId: "convo-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 1,
    sourceHash: "previous-hash",
    status: "complete",
    error: null,
    modelProvider: "claude",
    model: "sonnet",
    effort: "medium",
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    createdBy: "user",
    createdByConversationId: null,
    payload: makePreviousEnvelope(),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let fixture: PersistenceFixture;
let repo: ContextArtifactsRepo;
let events: SSEEvent[];
let prompts: string[];

beforeEach(() => {
  vi.clearAllMocks();
  fixture = createPersistenceFixture();
  repo = createContextArtifactsRepo(fixture.db);
  events = [];
  prompts = [];
});

afterEach(() => {
  fixture.close();
});

function makeService(
  executeTaskRun: (
    input: ExecuteWorkflowTaskRunInput,
  ) => Promise<TaskRunResult>,
  entries: TranscriptEntriesResult = ENTRIES,
  config: CompactionConfig = compactionConfigSchema.parse({}),
): CompactionService {
  return createCompactionService({
    executeTaskRun: async (input) => {
      prompts.push(input.prompt);
      return executeTaskRun(input);
    },
    readEntries: async () => entries,
    repo,
    resolveConfig: async () => config,
    broadcast: (event) => {
      events.push(event);
    },
    now: () => "2026-07-05T00:00:00Z",
  });
}

function echoService(
  entries: TranscriptEntriesResult = ENTRIES,
): CompactionService {
  return makeService(
    async (input) => structuredResult(envelopeFromPrompt(input.prompt)),
    entries,
  );
}

describe("createCompactionService — full run", () => {
  it("persists a complete artifact with coverage, versions, and provenance", async () => {
    const service = echoService();
    const result = await service.trigger(makeTriggerInput());
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;

    const row = await result.completion;
    expect(row.status).toBe("complete");

    const reloaded = repo.findById(result.artifactId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.kind).toBe("conversation_compaction");
    expect(reloaded?.coveredStartSeq).toBe(0);
    expect(reloaded?.coveredEndSeq).toBe(3);
    expect(reloaded?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reloaded?.modelProvider).toBe("claude");
    expect(reloaded?.model).toBe("sonnet");
    expect(reloaded?.effort).toBe("medium");
    expect(reloaded?.schemaVersion).toBe(CONTEXT_ARTIFACT_SCHEMA_VERSION);
    expect(reloaded?.promptVersion).toBe(PROMPT_VERSION);
    expect(reloaded?.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(reloaded?.createdBy).toBe("user");
    expect(reloaded?.payload?.agentBrief).toBe("dense handoff brief");
    expect(reloaded?.payload?.source.coveredEndSeq).toBe(3);
  });

  it("runs the model on a synthetic transient lane, never the target conversation", async () => {
    const captured: ExecuteWorkflowTaskRunInput[] = [];
    const service = makeService(async (input) => {
      captured.push(input);
      return structuredResult(envelopeFromPrompt(input.prompt));
    });

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.conversationId).not.toBe("convo-1");
    expect(call?.actorInput).toBeDefined();
    // Constructed ephemeral so the injected persistence adapter makes every
    // durable side effect inert for the synthetic lane (no ConversationState
    // record exists for it).
    expect(call?.actorInput?.persistence).toBe("ephemeral");
    expect(call?.actorInput?.conversation.agentBackend).toBe("claude");
    expect(call?.actorInput?.conversation.transcriptPath).toBeNull();
    expect(call?.outputFormat?.type).toBe("json_schema");
    expect(call?.modelId).toBe("sonnet");
    expect(call?.effort).toBe("medium");
    // Unset compaction timeout resolves to 0 — the task runner's "no timeout".
    expect(call?.timeoutMs).toBe(0);
  });

  it("passes a configured compaction timeout through to the task run", async () => {
    const captured: ExecuteWorkflowTaskRunInput[] = [];
    const service = makeService(
      async (input) => {
        captured.push(input);
        return structuredResult(envelopeFromPrompt(input.prompt));
      },
      ENTRIES,
      { ...compactionConfigSchema.parse({}), timeoutMs: 120_000 },
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    expect(result.timeoutMs).toBe(120_000);
    await result.completion;

    expect(captured[0]?.timeoutMs).toBe(120_000);
  });

  it("resolves an explicit null compaction timeout to the no-timeout sentinel", async () => {
    const captured: ExecuteWorkflowTaskRunInput[] = [];
    const service = makeService(
      async (input) => {
        captured.push(input);
        return structuredResult(envelopeFromPrompt(input.prompt));
      },
      ENTRIES,
      { ...compactionConfigSchema.parse({}), timeoutMs: null },
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    expect(result.timeoutMs).toBe(0);
    await result.completion;

    expect(captured[0]?.timeoutMs).toBe(0);
  });

  it("broadcasts dual-scope pending and complete SSE events", async () => {
    const service = echoService();
    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "context_artifact_status",
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "convo-1",
      artifactId: result.artifactId,
      kind: "conversation_compaction",
      status: "pending",
    });
    expect(events[1]).toMatchObject({
      type: "context_artifact_status",
      status: "complete",
    });
  });

  it("uses the project event identity for project-scope conversations", async () => {
    const service = echoService();
    const result = await service.trigger(
      makeTriggerInput({ scope: "project", sessionName: null }),
    );
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    expect(events[0]).toMatchObject({ scope: "project", projectName: "proj" });
    expect(events[0]).not.toHaveProperty("sessionName");
  });

  it("redacts the rendered transcript before the model and the envelope before persistence", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwx";
    const entries: TranscriptEntriesResult = {
      entries: [
        makeEntry(0, "user", `here is a token ${secret}`),
        makeEntry(1, "assistant", "acknowledged"),
      ],
      maxSeq: 1,
    };
    const service = makeService(
      async (input) =>
        structuredResult(
          envelopeFromPrompt(input.prompt, {
            agentBrief: `user leaked ${secret} in the transcript`,
          }),
        ),
      entries,
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    expect(prompts[0]).not.toContain(secret);
    expect(prompts[0]).toContain("[REDACTED:github-token]");

    const reloaded = repo.findById(result.artifactId);
    expect(reloaded?.payload?.agentBrief).not.toContain(secret);
    expect(reloaded?.payload?.agentBrief).toContain("[REDACTED:github-token]");
  });
});

describe("createCompactionService — delta run", () => {
  it("runs a delta over the new lines and preserves the row identity", async () => {
    repo.upsert(makeCompleteRow());
    const service = makeService(async (input) =>
      structuredResult(
        envelopeFromPrompt(input.prompt, {
          decisions: [
            {
              statement: "use sqlite",
              status: "accepted",
              sourceRefs: [
                {
                  messageIndex: 0,
                  messageId: "entry-0",
                  seqStart: 0,
                  seqEnd: 0,
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    expect(result.artifactId).toBe("existing-artifact");
    const row = await result.completion;

    expect(prompts[0]).toContain("## Previous compaction envelope");
    expect(prompts[0]).toContain("## New transcript lines (after seq 1)");
    expect(prompts[0]).not.toContain("first question");
    expect(prompts[0]).toContain("second question");

    expect(row.status).toBe("complete");
    const reloaded = repo.findById("existing-artifact");
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.error).toBeNull();
    expect(reloaded?.coveredStartSeq).toBe(0);
    expect(reloaded?.coveredEndSeq).toBe(3);
    expect(reloaded?.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(
      reloaded?.payload?.decisions.map((decision) => decision.statement),
    ).toContain("use sqlite");
  });

  it("falls back to one full run after two delta guard failures", async () => {
    repo.upsert(makeCompleteRow());
    const service = makeService(async (input) =>
      // Delta prompts get an envelope that drops the previous decision
      // (guard violation); the full fallback gets a valid one.
      structuredResult(envelopeFromPrompt(input.prompt)),
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("Delta update rules");
    expect(prompts[1]).toContain("Delta update rules");
    expect(prompts[1]).toContain("## Previous attempt rejected");
    expect(prompts[1]).toContain("previous decision was dropped");
    expect(prompts[2]).not.toContain("Delta update rules");

    expect(row.status).toBe("complete");
    const reloaded = repo.findById("existing-artifact");
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.coveredStartSeq).toBe(0);
    expect(reloaded?.coveredEndSeq).toBe(3);

    const guardFailures = logSpies.warn.mock.calls.filter(
      ([event]) => event === "artifact.delta.guard_failed",
    );
    expect(guardFailures.length).toBeGreaterThanOrEqual(2);
  });

  it("skips delta and reruns full when the artifact is version-outdated", async () => {
    repo.upsert(makeCompleteRow({ promptVersion: "0", coveredEndSeq: 1 }));
    const service = echoService();

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    expect(prompts[0]).not.toContain("Delta update rules");
  });
});

describe("createCompactionService — retries and failures", () => {
  it("retries once on schema failure naming the violations, then fails", async () => {
    const service = makeService(async () => structuredResult({ bogus: true }));

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Previous attempt rejected");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("schema");

    const reloaded = repo.findById(result.artifactId);
    expect(reloaded?.status).toBe("failed");
    expect(events.map((event) => "status" in event && event.status)).toEqual([
      "pending",
      "failed",
    ]);
  });

  it("fails immediately without retry on a task-run error", async () => {
    const service = makeService(async () => ({
      kind: "error",
      error: "backend exploded",
      aborted: false,
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    }));

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts).toHaveLength(1);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("backend exploded");
  });

  it("fails with transcript_too_large_for_single_pass on oversize renders", async () => {
    const oversize: TranscriptEntriesResult = {
      entries: [
        makeEntry(0, "user", "x".repeat(COMPACTION_MODEL_BUDGET_BYTES + 100)),
      ],
      maxSeq: 0,
    };
    const service = echoService(oversize);

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("transcript_too_large_for_single_pass");
  });
});

describe("createCompactionService — coalescing and freshness", () => {
  it("coalesces a concurrent trigger onto the running generation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const service = makeService(async (input) => {
      calls += 1;
      await gate;
      return structuredResult(envelopeFromPrompt(input.prompt));
    });

    const first = await service.trigger(makeTriggerInput());
    if (first.outcome !== "started") throw new Error("expected started");
    const second = await service.trigger(makeTriggerInput());
    expect(second.outcome).toBe("coalesced");
    if (second.outcome !== "coalesced") return;
    expect(second.artifactId).toBe(first.artifactId);

    release?.();
    const [rowA, rowB] = await Promise.all([
      first.completion,
      second.completion,
    ]);
    expect(calls).toBe(1);
    expect(rowA.status).toBe("complete");
    expect(rowB.status).toBe("complete");

    const third = await service.trigger(makeTriggerInput());
    expect(third.outcome).toBe("already_fresh");
  });

  it("coalesces triggers racing through the pre-registration awaits into one generation", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let readCalls = 0;
    let modelCalls = 0;
    const service = createCompactionService({
      executeTaskRun: async (input) => {
        modelCalls += 1;
        await modelGate;
        return structuredResult(envelopeFromPrompt(input.prompt));
      },
      readEntries: async () => {
        readCalls += 1;
        await readGate;
        return ENTRIES;
      },
      repo,
      resolveConfig: async () => compactionConfigSchema.parse({}),
      broadcast: (event) => {
        events.push(event);
      },
      now: () => "2026-07-05T00:00:00Z",
    });

    const firstPromise = service.trigger(makeTriggerInput());
    const secondPromise = service.trigger(makeTriggerInput());
    releaseRead();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([first.outcome, second.outcome].sort()).toEqual([
      "coalesced",
      "started",
    ]);
    if (first.outcome !== "started" && first.outcome !== "coalesced") return;
    if (second.outcome !== "started" && second.outcome !== "coalesced") return;
    expect(second.artifactId).toBe(first.artifactId);

    releaseModel();
    const [rowA, rowB] = await Promise.all([
      first.completion,
      second.completion,
    ]);
    expect(modelCalls).toBe(1);
    expect(readCalls).toBe(1);
    expect(rowA.status).toBe("complete");
    expect(rowB.id).toBe(rowA.id);
    expect(repo.findByConversation("convo-1")).toHaveLength(1);
    expect(
      events.map((event) => ("status" in event ? event.status : null)),
    ).toEqual(["pending", "complete"]);
  });

  it("keeps the previous achieved coverage on the row while a refresh is pending and after it fails", async () => {
    repo.upsert(makeCompleteRow({ coveredStartSeq: 0, coveredEndSeq: 1 }));
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const service = makeService(async () => {
      await modelGate;
      return {
        kind: "error",
        error: "backend exploded",
        aborted: false,
        usage: USAGE,
        backendRef: null,
        continuationDisposition: "retain",
      };
    });

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");

    const pendingRow = repo.findById("existing-artifact");
    expect(pendingRow?.status).toBe("pending");
    expect(pendingRow?.coveredStartSeq).toBe(0);
    expect(pendingRow?.coveredEndSeq).toBe(1);

    releaseModel();
    await result.completion;

    const failedRow = repo.findById("existing-artifact");
    expect(failedRow).not.toBeNull();
    if (!failedRow) return;
    expect(failedRow.status).toBe("failed");
    expect(failedRow.coveredStartSeq).toBe(0);
    expect(failedRow.coveredEndSeq).toBe(1);
    expect(failedRow.payload?.source.coveredEndSeq).toBe(1);
    expect(
      deriveFreshness(failedRow, {
        promptVersion: PROMPT_VERSION,
        normalizerVersion: NORMALIZER_VERSION,
        schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
        maxSeq: ENTRIES.maxSeq,
      }).stale,
    ).toBe(true);
  });

  it("does not resurrect an artifact deleted while its generation is in flight", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const service = makeService(async (input) => {
      await modelGate;
      return structuredResult(envelopeFromPrompt(input.prompt));
    });

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");

    expect(repo.deleteById(result.artifactId)).toBe(true);
    releaseModel();
    await result.completion;

    expect(repo.findById(result.artifactId)).toBeNull();
    expect(repo.findByConversation("convo-1")).toHaveLength(0);
    expect(
      events.map((event) => ("status" in event ? event.status : null)),
    ).toEqual(["pending"]);
  });

  it("returns already_fresh for a complete, current artifact without calling the model", async () => {
    repo.upsert(makeCompleteRow({ coveredEndSeq: 3 }));
    const service = echoService();

    const result = await service.trigger(makeTriggerInput());
    expect(result.outcome).toBe("already_fresh");
    if (result.outcome !== "already_fresh") return;
    expect(result.artifact.id).toBe("existing-artifact");
    expect(prompts).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("force regenerates a fresh artifact with a full run", async () => {
    repo.upsert(makeCompleteRow({ coveredEndSeq: 3 }));
    const service = echoService();

    const result = await service.trigger(makeTriggerInput({ force: true }));
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    await result.completion;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Delta update rules");
  });
});

describe("createCompactionService — message compaction", () => {
  it("compacts a single logical message with entry-exact coverage", async () => {
    const service = echoService();
    const result = await service.trigger(
      makeTriggerInput({ kind: "message_compaction", messageIndex: 1 }),
    );
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts[0]).toContain("first answer");
    expect(prompts[0]).not.toContain("second question");

    expect(row.kind).toBe("message_compaction");
    expect(row.messageIndex).toBe(1);
    expect(row.messageId).toBe("entry-1");
    expect(row.coveredStartSeq).toBe(1);
    expect(row.coveredEndSeq).toBe(1);
    expect(repo.findMessageArtifact("convo-1", 1)?.status).toBe("complete");
  });

  it("treats message artifacts as always fresh; only force regenerates", async () => {
    const service = echoService();
    const first = await service.trigger(
      makeTriggerInput({ kind: "message_compaction", messageIndex: 1 }),
    );
    if (first.outcome !== "started") throw new Error("expected started");
    await first.completion;

    const second = await service.trigger(
      makeTriggerInput({ kind: "message_compaction", messageIndex: 1 }),
    );
    expect(second.outcome).toBe("already_fresh");

    const third = await service.trigger(
      makeTriggerInput({
        kind: "message_compaction",
        messageIndex: 1,
        force: true,
      }),
    );
    expect(third.outcome).toBe("started");
    if (third.outcome !== "started") return;
    await third.completion;
    expect(prompts).toHaveLength(2);
  });

  it("refreshes a version-outdated message artifact on a plain trigger", async () => {
    repo.upsert(
      makeCompleteRow({
        id: "msg-artifact",
        kind: "message_compaction",
        messageIndex: 1,
        messageId: "entry-1",
        coveredStartSeq: 1,
        coveredEndSeq: 1,
        promptVersion: "0",
      }),
    );
    const service = echoService();

    const result = await service.trigger(
      makeTriggerInput({ kind: "message_compaction", messageIndex: 1 }),
    );
    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    expect(result.artifactId).toBe("msg-artifact");
    await result.completion;

    const reloaded = repo.findMessageArtifact("convo-1", 1);
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.promptVersion).toBe(PROMPT_VERSION);
  });

  it("rejects a missing or out-of-range messageIndex", async () => {
    const service = echoService();

    const missing = await service.trigger(
      makeTriggerInput({ kind: "message_compaction" }),
    );
    expect(missing.outcome).toBe("invalid");

    const outOfRange = await service.trigger(
      makeTriggerInput({ kind: "message_compaction", messageIndex: 99 }),
    );
    expect(outOfRange.outcome).toBe("invalid");
  });

  it("rejects conversation compaction of an empty transcript", async () => {
    const service = echoService({ entries: [], maxSeq: -1 });
    const result = await service.trigger(makeTriggerInput());
    expect(result.outcome).toBe("invalid");
  });
});

describe("createCompactionService — audit logging", () => {
  it("emits audit.compaction_triggered with caller and target", async () => {
    const service = echoService();
    const result = await service.trigger(
      makeTriggerInput({
        createdBy: "agent",
        createdByConversationId: "caller-9",
        trigger: "agent_api",
      }),
    );
    if (result.outcome !== "started") throw new Error("expected started");
    await result.completion;

    const audit = logSpies.info.mock.calls.find(
      ([event]) => event === "audit.compaction_triggered",
    );
    expect(audit).toBeDefined();
    expect(audit?.[1]).toMatchObject({
      callerConversationId: "caller-9",
      targetConversationId: "convo-1",
      trigger: "agent_api",
    });

    const reloaded = repo.findById(result.artifactId);
    expect(reloaded?.createdBy).toBe("agent");
    expect(reloaded?.createdByConversationId).toBe("caller-9");
  });
});

describe("createCompactionService — delta-fold (large conversations)", () => {
  // Four alternating-role messages, each large enough that the whole render
  // exceeds the single-pass budget but two fit within one segment window
  // (SEGMENT_WINDOW_BUDGET_BYTES) → two fold segments.
  function oversizeEntries(): TranscriptEntriesResult {
    const body = "a".repeat(200_000);
    return {
      entries: [
        makeEntry(0, "user", body),
        makeEntry(1, "assistant", body),
        makeEntry(2, "user", body),
        makeEntry(3, "assistant", body),
      ],
      maxSeq: 3,
    };
  }

  /** Read the previous-envelope decisions a delta prompt carries forward. */
  function previousDecisions(prompt: string): CompactionEnvelope["decisions"] {
    const marker = "## Previous compaction envelope\n```json\n";
    const start = prompt.indexOf(marker);
    if (start === -1) return [];
    const jsonStart = start + marker.length;
    const jsonEnd = prompt.indexOf("\n```", jsonStart);
    const prev = JSON.parse(
      prompt.slice(jsonStart, jsonEnd),
    ) as CompactionEnvelope;
    return prev.decisions;
  }

  it("folds an oversize conversation into one complete artifact covering everything", async () => {
    const service = echoService(oversizeEntries());
    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    // One full step then one delta step — never a single oversize pass.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Delta update rules");
    expect(prompts[1]).toContain("Delta update rules");
    expect(prompts[1]).toContain("## Previous compaction envelope");

    expect(row.status).toBe("complete");
    const reloaded = repo.findById(result.artifactId);
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.coveredStartSeq).toBe(0);
    expect(reloaded?.coveredEndSeq).toBe(3);
    expect(reloaded?.payload?.source.coveredEndSeq).toBe(3);
    expect(reloaded?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events.map((e) => ("status" in e ? e.status : null))).toEqual([
      "pending",
      "complete",
    ]);
  });

  it("carries decisions forward across fold steps and rejects a step that drops one", async () => {
    const withDecision = {
      decisions: [
        {
          statement: "adopt the fold approach",
          status: "accepted" as const,
          sourceRefs: [
            { messageIndex: 0, messageId: "entry-0", seqStart: 0, seqEnd: 0 },
          ],
        },
      ],
    };
    let deltaAttempts = 0;
    const service = makeService(async (input) => {
      const isDelta = input.prompt.includes("## Previous compaction envelope");
      if (!isDelta) {
        return structuredResult(envelopeFromPrompt(input.prompt, withDecision));
      }
      deltaAttempts += 1;
      // First delta attempt drops the prior decision (guard violation); the
      // retry carries it forward.
      if (deltaAttempts === 1) {
        return structuredResult(envelopeFromPrompt(input.prompt));
      }
      return structuredResult(envelopeFromPrompt(input.prompt, withDecision));
    }, oversizeEntries());

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    // full + delta-attempt-1 (dropped) + delta-attempt-2 (corrected).
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("## Previous attempt rejected");
    expect(prompts[2]).toContain("previous decision was dropped");

    expect(row.status).toBe("complete");
    const reloaded = repo.findById(result.artifactId);
    expect(reloaded?.coveredEndSeq).toBe(3);
    expect(reloaded?.payload?.decisions.map((d) => d.statement)).toContain(
      "adopt the fold approach",
    );

    const foldGuardFailures = logSpies.warn.mock.calls.filter(
      ([event]) => event === "artifact.fold.guard_failed",
    );
    expect(foldGuardFailures.length).toBeGreaterThanOrEqual(1);
    expect(foldGuardFailures[0]?.[1]).toMatchObject({ segment: 2, of: 2 });
  });

  it("fails naming the segment when a fold step errors, leaving prior coverage intact", async () => {
    const service = makeService(async (input) => {
      if (input.prompt.includes("## Previous compaction envelope")) {
        return {
          kind: "error",
          error: "segment backend exploded",
          aborted: false,
          usage: USAGE,
          backendRef: null,
          continuationDisposition: "retain",
        };
      }
      return structuredResult(envelopeFromPrompt(input.prompt));
    }, oversizeEntries());

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(row.status).toBe("failed");
    expect(row.error).toContain("segment 2/2");
    expect(row.error).toContain("segment backend exploded");
    expect(repo.findById(result.artifactId)?.status).toBe("failed");
  });

  it("folds only the new lines when refreshing a large delta onto an existing artifact", async () => {
    repo.upsert(makeCompleteRow({ coveredStartSeq: 0, coveredEndSeq: 1 }));
    const body = "a".repeat(200_000);
    const entries: TranscriptEntriesResult = {
      entries: [
        makeEntry(0, "user", "first question"),
        makeEntry(1, "assistant", "first answer"),
        makeEntry(2, "user", body),
        makeEntry(3, "assistant", body),
        makeEntry(4, "user", body),
        makeEntry(5, "assistant", body),
      ],
      maxSeq: 5,
    };
    // A model that faithfully carries forward whatever the previous envelope
    // holds, so every delta fold step preserves the seeded decision.
    const service = makeService(
      async (input) =>
        structuredResult(
          envelopeFromPrompt(input.prompt, {
            decisions: previousDecisions(input.prompt),
          }),
        ),
      entries,
    );

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    expect(result.artifactId).toBe("existing-artifact");
    const row = await result.completion;

    // Both fold steps are deltas seeded from the existing artifact; the first
    // renders only the new lines, never the already-covered seq 0–1.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Delta update rules");
    expect(prompts[0]).not.toContain("first question");

    expect(row.status).toBe("complete");
    const reloaded = repo.findById("existing-artifact");
    expect(reloaded?.coveredStartSeq).toBe(0);
    expect(reloaded?.coveredEndSeq).toBe(5);
    expect(reloaded?.payload?.decisions.map((d) => d.statement)).toContain(
      "use sqlite",
    );
  });

  it("still fails a lone message larger than the budget — folding cannot help", async () => {
    const service = echoService({
      entries: [
        makeEntry(0, "user", "x".repeat(COMPACTION_MODEL_BUDGET_BYTES + 100)),
      ],
      maxSeq: 0,
    });
    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    expect(prompts).toHaveLength(0);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("transcript_too_large_for_single_pass");
  });
});

describe("createCompactionService — trailing tool_result coverage", () => {
  it("extends full-run expected coverage over a trailing tool_result entry so refs to its rendered lines pass guards", async () => {
    const trailingToolResult: TranscriptEntryWithSeq = {
      kind: "tool_result",
      seq: 4,
      entryId: null,
      timestamp: "2026-01-01T00:00:00Z",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "tool output" },
      ],
    };
    const service = echoService({
      entries: [...ENTRIES.entries, trailingToolResult],
      maxSeq: 3,
    });

    const result = await service.trigger(makeTriggerInput());
    if (result.outcome !== "started") throw new Error("expected started");
    const row = await result.completion;

    // The render includes the [s4] tool_result lines, so the coverage claim
    // (and therefore the sourceRef guard window) must reach seq 4 — while
    // staleness still derives from maxSeq (3), so the artifact stays fresh.
    expect(row.status).toBe("complete");
    expect(row.coveredEndSeq).toBe(4);
    const freshness = deriveFreshness(row, {
      maxSeq: 3,
      promptVersion: PROMPT_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    });
    expect(freshness.stale).toBe(false);
  });
});
