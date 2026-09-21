import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createConfigRouteHandlers } from "@/lib/config/route-handlers";
import { resolveCompactionConfig } from "@/lib/config/cascade";
import { describe, it, expect, vi, beforeEach } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Infrastructure-only mock (module-level createLogger side effect); every
// generation dependency is injected.
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => logSpies,
}));

import {
  generateCheckpoint,
  CHECKPOINT_GENERATOR_VERSION,
  type GenerateCheckpointInput,
} from "./generation";
import { captureCheckpointSource } from "./source";
import {
  CHECKPOINT_BUILDER_VERSION,
  CHECKPOINT_SEED_BUDGET,
  utf8ByteLength,
} from "./budget";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  checkpointPayloadSchema,
} from "./schemas";
import {
  compactionEnvelopeSchema,
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import { PROMPT_VERSION } from "@/lib/context-artifacts/generation";
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import { compactionConfigSchema } from "@/lib/config/schemas";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

const USAGE = {
  costUsd: 0.5,
  durationMs: 1000,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: 800,
  outputTokens: 200,
  cachedInputTokens: 12_000,
};

function structuredResult(output: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: output,
    text: "",
    usage: USAGE,
    backendRef: { backend: "claude", ref: "latest-working-state-session" },
    continuationDisposition: "retain",
  };
}

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
  text(0, "user", "the deploy key lives in vault path ops/deploy-2026"),
  text(1, "assistant", "acknowledged, using the vault path"),
  text(2, "user", "build the checkpoint seed next"),
  text(3, "assistant", "starting on the builder"),
];

function envelopeFor(
  conversationId: string,
  endSeq: number,
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "proj",
      sessionName: "sess",
      conversationId,
      coveredStartSeq: 0,
      coveredEndSeq: endSeq,
      messageCount: endSeq + 1,
      sourceHash: "envelope-hash",
    },
    agentBrief: "brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "build the checkpoint seed",
      nextBestActions: ["write the builder"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
}

const WORKING_STATE = {
  objective: {
    text: "deliver the bounded checkpoint seed",
    sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
  },
  latestRequest: {
    text: "build the checkpoint seed next",
    sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
  },
  outstandingRequests: [
    {
      text: "build the builder",
      sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
    },
  ],
  constraints: [
    {
      text: "seed is at most 32768 bytes",
      sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
    },
  ],
  decisions: [
    {
      statement: "source from the original archive",
      status: "accepted",
      rationale: "summary chains compound loss",
      sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
    },
  ],
  failedApproaches: [
    {
      approach: "token estimation for the budget",
      outcome: "rejected: bytes must be exact",
      sourceRefs: [{ messageIndex: 1, seqStart: 1, seqEnd: 1 }],
    },
  ],
  openQuestions: [
    {
      text: "which backends are proven",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
  blockers: [],
  nextActions: [
    {
      text: "freeze the rendered bytes",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
};

function artifactRow(
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
    coveredStartSeq: 0,
    coveredEndSeq: 3,
    sourceHash: "set-by-test",
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    createdBy: "user",
    createdByConversationId: null,
    payload: envelopeFor("convo-1", 3),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let calls: ExecuteWorkflowTaskRunInput[];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
});

async function capture(entries: TranscriptEntryWithSeq[] = ENTRIES) {
  return captureCheckpointSource(
    { conversationId: "convo-1", transcriptPath: "/tmp/convo-1.jsonl" },
    {
      readEntries: async () => ({
        entries,
        maxSeq: entries[entries.length - 1]?.seq ?? 0,
      }),
    },
  );
}

async function makeInput(
  overrides: Partial<GenerateCheckpointInput> = {},
): Promise<GenerateCheckpointInput> {
  const source = overrides.source ?? (await capture());
  return {
    identity: {
      conversationId: "convo-1",
      checkpointId: "ckpt-1",
      ordinal: 1,
      scope: "session",
    },
    source,
    existingArtifact: null,
    lane: {
      address: {
        projectPath: "/home/projects/proj",
        target: sessionConversationTarget("proj", "sess", "checkpoint-ckpt-1"),
      },
      worktreePath: "/home/projects/proj/.worktrees/sess",
      backend: "claude",
    },
    config: compactionConfigSchema.parse({}),
    createdAt: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

/** Echo the `source` block the compaction prompt tells the model to copy. */
function envelopeFromPrompt(prompt: string) {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("prompt has no source metadata section");
  const jsonStart = start + marker.length;
  const meta = JSON.parse(
    prompt.slice(jsonStart, prompt.indexOf("\n```", jsonStart)),
  ) as { kind: string; source: CompactionEnvelope["source"] };
  return {
    ...envelopeFor(meta.source.conversationId, meta.source.coveredEndSeq),
    source: meta.source,
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
  };
}

/** Answers the envelope pass with a valid envelope and the seed pass with working state. */
function modelDouble(workingState: unknown = WORKING_STATE) {
  return async (input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult> => {
    calls.push(input);
    if (input.prompt.includes("checkpoint working state")) {
      return structuredResult(workingState);
    }
    return structuredResult(envelopeFromPrompt(input.prompt));
  };
}

describe("generateCheckpoint — payload", () => {
  it("uses the saved global backend, model, and reasoning for every checkpoint generation pass", async () => {
    const tempRoot = path.join(process.cwd(), ".cc/temp");
    await mkdir(tempRoot, { recursive: true });
    const configDir = await mkdtemp(path.join(tempRoot, "checkpoint-config-"));
    try {
      const reader = createConfigReader(configDir);
      const handlers = createConfigRouteHandlers({
        readConfig: () => reader.readConfig(),
        readRawConfig: () => reader.readRawConfig(),
        writeRawConfig: (config) => reader.writeRawConfig(config),
      });
      const selection = {
        modelId: "gpt-5.4-mini",
        parameters: { reasoning: "low", fast: "false" },
      };
      const response = await handlers.PUT(
        new Request("http://localhost/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            compaction: {
              backend: "codex",
              conversationModelSelection: selection,
              messageModelSelection: selection,
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const reloaded = createConfigReader(configDir);
      const config = resolveCompactionConfig(await reloaded.readConfig());
      expect(config.backend).toBe("codex");
      expect(config.conversationModelSelection).toEqual(selection);
      const input = await makeInput({ config });
      input.lane.backend = config.backend;
      const result = await generateCheckpoint(input, {
        executeTaskRun: modelDouble(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.payload.modelSelection).toEqual(selection);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(call.modelSelection).toEqual(selection);
        expect(call.binding).toMatchObject({ backend: "codex" });
      }
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("freezes the built seed with its boundary, versions, and exact byte counts", async () => {
    const input = await makeInput();
    const result = await generateCheckpoint(input, {
      executeTaskRun: modelDouble(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = checkpointPayloadSchema.parse(result.payload);

    expect(payload.id).toBe("ckpt-1");
    expect(payload.schemaVersion).toBe(CHECKPOINT_PAYLOAD_SCHEMA_VERSION);
    expect(payload.sourceBasis).toEqual(input.source.basis);
    expect(payload.versions).toEqual({
      generatorVersion: CHECKPOINT_GENERATOR_VERSION,
      builderVersion: CHECKPOINT_BUILDER_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
    });
    expect(payload.modelSelection).toEqual(
      input.config.conversationModelSelection,
    );
    expect(payload.sectionBytes.total).toBe(utf8ByteLength(payload.seedText));
    expect(payload.sectionBytes.total).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.total,
    );
    expect(payload.createdAt).toBe("2026-07-05T00:00:00Z");
    expect(payload.generationPassCount).toBe(result.generationPassCount);
    expect(payload.seedText).toContain("deliver the bounded checkpoint seed");
  });

  it("injects no carried envelope, index, or receipt alongside the seed", async () => {
    const input = await makeInput();
    const result = await generateCheckpoint(input, {
      executeTaskRun: modelDouble(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The envelope is generation input, not seed content.
    expect(result.payload.seedText).not.toContain("agentBrief");
    expect(result.payload.seedText).not.toContain("nextBestActions");
    expect(result.payload.seedText).not.toContain("envelope-hash");
    expect(result.payload.seedText).not.toContain("schemaVersion");
  });

  it("runs on the resolved worktree lane and never on the source conversation", async () => {
    const input = await makeInput();
    await generateCheckpoint(input, { executeTaskRun: modelDouble() });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.binding.kind).toBe("ephemeral");
      expect(call.binding.worktreePath).toBe(
        "/home/projects/proj/.worktrees/sess",
      );
      expect(call.binding.address.target.conversationId).not.toBe("convo-1");
    }
  });
});

describe("generateCheckpoint — envelope reuse", () => {
  it("reuses a matching complete envelope and runs only the seed pass", async () => {
    const source = await capture();
    const input = await makeInput({
      source,
      existingArtifact: artifactRow({ sourceHash: source.markdownHash }),
    });
    const result = await generateCheckpoint(input, {
      executeTaskRun: modelDouble(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("checkpoint working state");
    expect(calls[0]?.structuredOutputTurns).toBe("work_then_format");
    expect(result.generationPassCount).toBe(1);
    expect(result.payload.artifactProvenance).toEqual({
      artifactId: "artifact-1",
      artifactSourceHash: source.markdownHash,
    });
  });

  it("regenerates the envelope when the artifact's coverage or version does not match", async () => {
    const source = await capture();
    const stale = artifactRow({
      sourceHash: source.markdownHash,
      promptVersion: "0",
    });
    const result = await generateCheckpoint(
      await makeInput({ source, existingArtifact: stale }),
      { executeTaskRun: modelDouble() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(result.generationPassCount).toBe(2);
    expect(result.payload.artifactProvenance).toBeNull();
  });

  it("sources a later checkpoint from the original archive, including facts an earlier seed omitted", async () => {
    // A conversation long enough that its earliest turn falls outside the
    // recent-dialogue budget of any checkpoint taken over it.
    const long: TranscriptEntryWithSeq[] = [...ENTRIES];
    for (let seq = 4; seq < 40; seq++) {
      long.push(
        text(
          seq,
          seq % 2 === 0 ? "user" : "assistant",
          `turn ${seq} ${"z".repeat(500)}`,
        ),
      );
    }
    const first = await generateCheckpoint(
      await makeInput({ source: await capture(long) }),
      { executeTaskRun: modelDouble() },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const seedOne = first.payload.seedText;
    expect(seedOne).not.toContain("ops/deploy-2026");

    const longer = [...long];
    for (let seq = 40; seq < 60; seq++) {
      longer.push(
        text(
          seq,
          seq % 2 === 0 ? "user" : "assistant",
          `turn ${seq} ${"z".repeat(500)}`,
        ),
      );
    }
    calls = [];
    const second = await generateCheckpoint(
      await makeInput({ source: await capture(longer) }),
      { executeTaskRun: modelDouble() },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The later build reads the original archive, so the early fact is still
    // in its generation input rather than only in the earlier summary.
    const envelopePrompt = calls.find(
      (call) => !call.prompt.includes("checkpoint working state"),
    );
    expect(envelopePrompt?.prompt).toContain("ops/deploy-2026");
    expect(envelopePrompt?.prompt).not.toContain(seedOne);
    expect(second.payload.sourceBasis.capturedThroughSeq).toBe(59);
  });
});

describe("generateCheckpoint — bounded repair", () => {
  it("repairs invalid working state once and counts the repair pass", async () => {
    let seedAttempts = 0;
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        if (!input.prompt.includes("checkpoint working state")) {
          return structuredResult(envelopeFromPrompt(input.prompt));
        }
        seedAttempts += 1;
        if (seedAttempts === 1) {
          return structuredResult({
            ...WORKING_STATE,
            nextActions: [
              {
                text: "cite a line outside the boundary",
                sourceRefs: [{ messageIndex: 9, seqStart: 99, seqEnd: 99 }],
              },
            ],
          });
        }
        return structuredResult(WORKING_STATE);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seedAttempts).toBe(2);
    expect(calls[2]?.resumeRef).toEqual({
      backend: "claude",
      ref: "latest-working-state-session",
    });
    expect(calls[1]?.structuredOutputTurns).toBe("work_then_format");
    expect(calls[2]?.structuredOutputTurns).toBe("single");
    expect(result.generationPassCount).toBe(3);
    expect(result.payload.generationPassCount).toBe(3);
  });

  it.each(["missing", "cleared"] as const)(
    "does not start a fresh working-state repair when continuity is %s",
    async (continuity) => {
      const invalid = {
        ...WORKING_STATE,
        nextActions: [
          {
            text: "outside",
            sourceRefs: [{ messageIndex: 0, seqStart: 99, seqEnd: 99 }],
          },
        ],
      };
      const result = await generateCheckpoint(await makeInput(), {
        executeTaskRun: async (input) => {
          const result = await modelDouble(invalid)(input);
          return {
            ...result,
            backendRef:
              continuity === "missing"
                ? null
                : { backend: "claude", ref: "unusable" },
            continuationDisposition:
              continuity === "cleared" ? "clear" : "retain",
          };
        },
      });
      expect(result).toMatchObject({
        ok: false,
        generationPassCount: 2,
        failure: { code: "working_state_invalid" },
      });
      expect(calls).toHaveLength(2);
    },
  );

  it("fails without a payload when the repaired working state is still invalid", async () => {
    const invalid = {
      ...WORKING_STATE,
      constraints: [
        {
          text: "outside the boundary",
          sourceRefs: [{ messageIndex: 0, seqStart: 400, seqEnd: 400 }],
        },
      ],
    };
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble(invalid),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).not.toHaveProperty("payload");
    expect(result.failure.code).toBe("working_state_invalid");
    expect(result.generationPassCount).toBe(3);
  });

  it("logs every generation pass, including the repair, with no prompt text", async () => {
    const invalidOnce = (() => {
      let served = 0;
      return () =>
        served++ === 0
          ? {
              ...WORKING_STATE,
              nextActions: [
                {
                  text: "outside the boundary",
                  sourceRefs: [{ messageIndex: 0, seqStart: 99, seqEnd: 99 }],
                },
              ],
            }
          : WORKING_STATE;
    })();
    await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        if (input.prompt.includes("checkpoint working state")) {
          return structuredResult(invalidOnce());
        }
        return structuredResult(envelopeFromPrompt(input.prompt));
      },
    });

    const passes = logSpies.info.mock.calls.filter(
      ([event]) => event === "checkpoint.generation.pass",
    );
    expect(
      passes.map(([, fields]) => ({
        index: fields.index,
        kind: fields.kind,
        outcome: fields.outcome,
      })),
    ).toEqual([
      { index: 1, kind: "initial", outcome: "ok" },
      { index: 2, kind: "initial", outcome: "guard" },
      { index: 3, kind: "guard_repair", outcome: "ok" },
    ]);
    for (const [, fields] of passes) {
      expect(fields).toMatchObject({
        conversationId: "convo-1",
        operationId: "ckpt-1",
      });
      expect(typeof fields.inputBytes).toBe("number");
      const serialized = JSON.stringify(fields);
      expect(serialized).not.toContain("deploy key");
      expect(serialized).not.toContain("checkpoint working state");
      expect(serialized).not.toContain("deliver the bounded checkpoint seed");
    }
  });

  it("records the source capture boundary once, without the captured text", async () => {
    await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble(),
    });

    const captured = logSpies.info.mock.calls.filter(
      ([event]) => event === "checkpoint.source.captured",
    );
    expect(captured).toHaveLength(1);
    const [, fields] = captured[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({
      conversationId: "convo-1",
      operationId: "ckpt-1",
      capturedThroughSeq: 3,
      firstSeq: 0,
      totalMessages: 4,
    });
    expect(fields.sourceHash).toEqual(expect.any(String));
    expect(JSON.stringify(fields)).not.toContain("deploy key");
  });

  it("does not retry a facade result rejected by the working-state schema", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble({ not: "a working state" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("working_state_schema");
    expect(calls).toHaveLength(2);
  });

  it("fails when the envelope pass fails, without attempting a seed pass", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        return {
          kind: "error",
          error: "backend exploded: ECHOED-PROMPT-BODY",
          text: "",
          aborted: false,
          usage: USAGE,
          backendRef: null,
          continuationDisposition: "retain",
        };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("envelope_generation_failed");
    expect(result.failure.message).not.toContain("ECHOED-PROMPT-BODY");
    expect(
      calls.every((call) => !call.prompt.includes("checkpoint working state")),
    ).toBe(true);
  });

  /**
   * A backend error is free text the checkpoint domain does not control: it
   * can echo the prompt it was handed, or name the provider session it failed
   * on. R9.2 keeps both out of the log, so the diagnostic carries the neutral
   * classification and the structural cause instead.
   */
  it("logs a backend failure by classification, never by its text", async () => {
    await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        return {
          kind: "error",
          error:
            'backend exploded on resume sess_01JQRESUME: "ECHOED-PROMPT-BODY"',
          text: "",
          aborted: false,
          failure: {
            kind: "backend_error",
            message: "ECHOED-PROMPT-BODY",
            retryable: false,
          },
          usage: USAGE,
          backendRef: null,
          continuationDisposition: "retain",
        };
      },
    });

    const failed = logSpies.warn.mock.calls.filter(
      ([event]) => event === "checkpoint.generation.failed",
    );
    expect(failed).toHaveLength(1);
    const [, fields] = failed[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({
      conversationId: "convo-1",
      operationId: "ckpt-1",
      code: "envelope_generation_failed",
      cause: "model_error",
      failureKind: "backend_error",
    });
    const rendered = JSON.stringify(fields);
    expect(rendered).not.toContain("ECHOED-PROMPT-BODY");
    expect(rendered).not.toContain("sess_01JQRESUME");
  });

  it.each(["envelope", "working-state"] as const)(
    "does not log source text from a %s facade schema refusal",
    async (stage) => {
      const result = await generateCheckpoint(await makeInput(), {
        executeTaskRun: async (input) => {
          if (
            stage === "working-state" &&
            !input.prompt.includes("checkpoint working state")
          ) {
            return structuredResult(envelopeFromPrompt(input.prompt));
          }
          return {
            kind: "error",
            error: "invalid JSON near ECHOED-PROMPT-BODY",
            structuredOutputIssues: ["invalid JSON near ECHOED-PROMPT-BODY"],
            aborted: false,
            usage: USAGE,
            backendRef: null,
            continuationDisposition: "retain",
          };
        },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("ECHOED-PROMPT-BODY");
      expect(JSON.stringify(logSpies.warn.mock.calls)).not.toContain(
        "ECHOED-PROMPT-BODY",
      );
    },
  );

  it("logs a rejected working state by its field paths, not the model's prose", async () => {
    await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble({
        not: "a working state",
        objective: "MODEL-AUTHORED-SENTENCE",
      }),
    });

    const failed = logSpies.warn.mock.calls.filter(
      ([event]) => event === "checkpoint.generation.failed",
    );
    expect(failed).toHaveLength(1);
    const [, fields] = failed[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({
      code: "working_state_schema",
      cause: "schema_invalid",
    });
    expect(fields.at).toEqual(
      expect.arrayContaining([expect.stringContaining("latestRequest")]),
    );
    expect(JSON.stringify(fields)).not.toContain("MODEL-AUTHORED-SENTENCE");
  });

  it("keeps model-produced text out of the receipt-visible failure message", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble({
        objective: {
          text: "MODEL-AUTHORED-SENTENCE",
          sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
        },
        latestRequest: { text: "", sourceRefs: [] },
        outstandingRequests: [],
        constraints: [],
        decisions: [],
        failedApproaches: [],
        openQuestions: [],
        blockers: [],
        nextActions: [],
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("working_state_schema");
    expect(result.failure.message).not.toContain("MODEL-AUTHORED-SENTENCE");
    expect(result.failure.message).toContain("latestRequest");
  });
});

describe("generateCheckpoint — telemetry and cancellation", () => {
  it("folds every pass's reported usage into one measured total", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble(),
    });

    expect(result.usage).toEqual({
      inputTokens: 1600,
      // Summed on its own axis: cached input is never folded into fresh input.
      cachedInputTokens: 24_000,
      outputTokens: 400,
      costUsd: 1,
      durationMs: 2000,
    });
    expect(result.generationPassCount).toBe(2);
  });

  it("leaves unreported counters null instead of zero", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        const nullUsage = {
          costUsd: null,
          durationMs: null,
          contextTokens: null,
          contextWindowMax: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        };
        const body = input.prompt.includes("checkpoint working state")
          ? WORKING_STATE
          : envelopeFromPrompt(input.prompt);
        return {
          kind: "structured",
          structuredOutput: body,
          text: "",
          usage: nullUsage,
          backendRef: null,
          continuationDisposition: "retain",
        };
      },
    });

    expect(result.usage).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    });
  });

  /**
   * A backend that reports cost on one pass and not the next makes the sum a
   * subtotal. Presenting it as the operation's cost understates the spend with
   * nothing saying so, and R9.3 forbids exactly that — an unavailable counter
   * stays null. The per-pass log keeps the measured subtotal visible.
   */
  it("leaves a counter unavailable when any pass failed to report it", async () => {
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        const seedPass = input.prompt.includes("checkpoint working state");
        return {
          kind: "structured",
          structuredOutput: seedPass
            ? WORKING_STATE
            : envelopeFromPrompt(input.prompt),
          text: "",
          usage: seedPass
            ? { ...USAGE, costUsd: null, durationMs: null }
            : USAGE,
          backendRef: null,
          continuationDisposition: "retain",
        };
      },
    });

    expect(result.usage).toEqual({
      inputTokens: 1600,
      cachedInputTokens: 24_000,
      outputTokens: 400,
      costUsd: null,
      durationMs: null,
    });
    expect(result.generationPassCount).toBe(2);
  });

  it("stops on its owned cancellation signal without producing a payload", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble(),
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("reports every observed pass to the caller's observer", async () => {
    const passes: string[] = [];
    await generateCheckpoint(await makeInput(), {
      executeTaskRun: modelDouble(),
      onPass: (pass) => {
        passes.push(`${pass.kind}:${pass.outcome}`);
      },
    });

    expect(passes).toEqual(["initial:ok", "initial:ok"]);
  });
});

describe("generateCheckpoint — diagnostics", () => {
  /**
   * `public-receipts-only` covers logs as well as receipts, and redaction is
   * not the mechanism: its patterns know credentials, not conversation, so a
   * backend sentence that echoes the prompt survives it. The diagnostic
   * carries no backend text at all.
   */
  it("writes no backend text into the diagnostic, redacted or otherwise", async () => {
    const warnings: { message: string; fields?: Record<string, unknown> }[] =
      [];
    const log = {
      debug: () => {},
      info: () => {},
      warn: (message: string, fields?: Record<string, unknown>) => {
        warnings.push({ message, fields });
      },
      error: () => {},
    };
    const secret = "api_key = sk-abcdefghijklmnopqrstuvwxyz012345";

    const result = await generateCheckpoint(await makeInput(), {
      executeTaskRun: async (input) => {
        calls.push(input);
        return {
          kind: "error",
          error: `${secret} ${"ECHOED-PROMPT-BODY ".repeat(400)}`,
          text: "",
          aborted: false,
          usage: USAGE,
          backendRef: null,
          continuationDisposition: "retain",
        };
      },
      log,
    });

    expect(result.ok).toBe(false);
    const failure = warnings.find(
      (entry) => entry.message === "checkpoint.generation.failed",
    );
    expect(failure).toBeDefined();
    const rendered = JSON.stringify(failure?.fields ?? {});
    expect(rendered).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(rendered).not.toContain("ECHOED-PROMPT-BODY");
    expect(rendered).not.toContain("api_key");
    expect(failure?.fields).toMatchObject({
      code: "envelope_generation_failed",
      cause: "model_error",
    });
    // Nothing in the payload is long enough to be a message body.
    for (const value of Object.values(failure?.fields ?? {}))
      expect(JSON.stringify(value).length).toBeLessThan(120);
  });
});

it("passes only the current advisory candidate to the builder and preserves the evidence repair budget", async () => {
  const agentHandoff = {
    plan: [
      {
        kind: "belief" as const,
        text: "ONLY_ADVISORY current hypothesis",
        sourceRefs: [],
      },
    ],
    hypotheses: [],
    failedApproaches: [],
    blockers: [],
    nextStep: [],
  };
  const input = await makeInput({ agentHandoff });
  let attempts = 0;
  const result = await generateCheckpoint(input, {
    executeTaskRun: async (request) => {
      calls.push(request);
      if (!request.prompt.includes("checkpoint working state"))
        return structuredResult(envelopeFromPrompt(request.prompt));
      attempts++;
      return structuredResult(
        attempts === 1
          ? {
              ...WORKING_STATE,
              objective: { text: "unsupported fact", sourceRefs: [] },
            }
          : WORKING_STATE,
      );
    },
  });
  expect(result).toMatchObject({
    ok: true,
    handoffDecision: "included",
    generationPassCount: 3,
  });
  expect(attempts).toBe(2);
  expect(calls.map((call) => call.prompt).join("\n")).not.toContain(
    "ONLY_ADVISORY",
  );
  if (!result.ok) throw new Error("generation failed");
  expect(result.payload.seedText).toContain("ONLY_ADVISORY");
  expect(result.payload.schemaVersion).toBe(1);
});

it("returns seed_budget omission without an extra generation or repair pass", async () => {
  const { buildCheckpointSeed, checkpointWorkingStateSchema } =
    await import("./builder");
  const state = checkpointWorkingStateSchema.parse(WORKING_STATE);
  const input = await makeInput();
  const initial = buildCheckpointSeed({
    identity: input.identity,
    source: {
      firstSeq: input.source.firstSeq,
      capturedThroughSeq: input.source.basis.capturedThroughSeq,
      totalMessages: input.source.totalMessages,
    },
    entries: input.source.captured.entries,
    workingState: state,
  });
  if (!initial.ok) throw new Error("baseline failed");
  state.objective.text += "x".repeat(
    CHECKPOINT_SEED_BUDGET.workingState -
      initial.seed.sectionBytes.workingState,
  );
  const result = await generateCheckpoint(
    {
      ...input,
      agentHandoff: {
        plan: [],
        hypotheses: [],
        failedApproaches: [],
        blockers: [],
        nextStep: [],
      },
    },
    { executeTaskRun: modelDouble(state) },
  );
  expect(result).toMatchObject({
    ok: true,
    handoffDecision: "seed_budget",
    generationPassCount: 2,
  });
  expect(calls).toHaveLength(2);
  if (!result.ok) throw new Error("generation failed");
  expect(result.payload.sections.workingState).toEqual(state);
  expect(result.payload.omissions).toContainEqual({
    category: "handoff_omitted",
    detail: "seed_budget",
  });
});
