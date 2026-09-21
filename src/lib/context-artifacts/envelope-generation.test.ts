import { describe, it, expect, vi, beforeEach } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Infrastructure-only mock (module-level createLogger side effect); every
// generation dependency is injected.
vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

import {
  generateCompactionEnvelope,
  CANCELLED_GENERATION_ERROR,
  COMPACTION_MODEL_BUDGET_BYTES,
  OVERSIZE_RENDER_ERROR,
  type CapturedTranscriptSource,
  type EnvelopeGenerationPass,
  type EnvelopeGenerationRequest,
} from "./envelope-generation";
import { compactionEnvelopeSchema, type CompactionEnvelope } from "./schemas";
import { deriveFreshness } from "./freshness";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

const USAGE = {
  costUsd: 0.25,
  durationMs: 1200,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: 900,
  outputTokens: 120,
  cachedInputTokens: null,
};

function structuredResult(output: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: output,
    text: "",
    usage: USAGE,
    backendRef: { backend: "claude", ref: "latest-envelope-session" },
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

function capturedSource(
  entries: TranscriptEntryWithSeq[] = [
    makeEntry(0, "user", "first question"),
    makeEntry(1, "assistant", "first answer"),
    makeEntry(2, "user", "second question"),
    makeEntry(3, "assistant", "second answer"),
  ],
): CapturedTranscriptSource {
  const maxSeq = entries[entries.length - 1]?.seq ?? 0;
  return {
    conversationId: "convo-1",
    entries,
    maxSeq,
    capturedThroughSeq: maxSeq,
  };
}

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
function envelopeFromPrompt(prompt: string) {
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

function makeRequest(
  overrides: Partial<EnvelopeGenerationRequest> = {},
): EnvelopeGenerationRequest {
  const source = overrides.source ?? capturedSource();
  return {
    runId: "run-1",
    kind: "conversation_compaction",
    messageIndex: null,
    projectName: "proj",
    sessionName: "sess",
    source,
    plan: {
      mode: "full",
      previousEnvelope: null,
      expected: {
        startSeq: source.entries[0]?.seq ?? 0,
        endSeq: source.maxSeq,
      },
    },
    lane: {
      address: {
        projectPath: "/home/projects/proj",
        target: sessionConversationTarget("proj", "sess", "compaction-run-1"),
      },
      worktreePath: "/home/projects/proj/.worktrees/sess",
      backend: "claude",
    },
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    timeoutMs: 60_000,
    ...overrides,
  };
}

let passes: EnvelopeGenerationPass[];
let calls: ExecuteWorkflowTaskRunInput[];

beforeEach(() => {
  vi.clearAllMocks();
  passes = [];
  calls = [];
});

function deps(
  executeTaskRun: (
    input: ExecuteWorkflowTaskRunInput,
  ) => Promise<TaskRunResult>,
  signal?: AbortSignal,
) {
  return {
    executeTaskRun: async (input: ExecuteWorkflowTaskRunInput) => {
      calls.push(input);
      return executeTaskRun(input);
    },
    onPass: (pass: EnvelopeGenerationPass) => {
      passes.push(pass);
    },
    ...(signal ? { signal } : {}),
  };
}

/** A resumed call answers from the prompt its session already holds. */
function sessionPrompt(input: ExecuteWorkflowTaskRunInput): string {
  if (input.resumeRef === undefined) return input.prompt;
  const opened = [...calls]
    .reverse()
    .find((call) => call.resumeRef === undefined);
  if (!opened) throw new Error("resumed call without an opening call");
  return opened.prompt;
}

const echo = async (input: ExecuteWorkflowTaskRunInput) =>
  structuredResult(envelopeFromPrompt(sessionPrompt(input)));

const CANCELLED_FAILURE = {
  code: "cancelled",
  segment: null,
  at: [],
  failureKind: null,
};
const OVERSIZE_FAILURE = { ...CANCELLED_FAILURE, code: "oversize_render" };

describe("generateCompactionEnvelope — captured source", () => {
  it("generates from the supplied snapshot and reports the single pass with its usage", async () => {
    const outcome = await generateCompactionEnvelope(makeRequest(), deps(echo));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.source.coveredStartSeq).toBe(0);
    expect(outcome.envelope.source.coveredEndSeq).toBe(3);
    expect(outcome.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.mode).toBe("full");
    expect(outcome.passCount).toBe(1);

    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({
      index: 1,
      kind: "initial",
      mode: "full",
      segment: null,
      outcome: "ok",
    });
    expect(passes[0]?.usage).toEqual(USAGE);
    expect(passes[0]?.inputBytes).toBeGreaterThan(0);
  });

  it("reads only the captured snapshot, never entries added after capture", async () => {
    const source = capturedSource();
    await generateCompactionEnvelope(makeRequest({ source }), deps(echo));
    // Mutating the caller's array after the run cannot change what was sent.
    expect(calls[0]?.prompt).toContain("second answer");
    expect(calls[0]?.prompt).not.toContain("a message appended later");
  });

  it("executes on the caller's resolved worktree, not the registered checkout", async () => {
    await generateCompactionEnvelope(makeRequest(), deps(echo));

    const binding = calls[0]?.binding;
    expect(binding).toMatchObject({
      kind: "ephemeral",
      worktreePath: "/home/projects/proj/.worktrees/sess",
      backend: "claude",
      role: null,
      transcriptPath: null,
    });
    expect(binding?.address.target.conversationId).toBe("compaction-run-1");
    expect(calls[0]?.executionClass).toBe("nongoverned-task");
    expect(calls[0]?.timeoutMs).toBe(60_000);
    expect(calls[0]?.modelSelection).toEqual({
      modelId: "sonnet",
      parameters: { effort: "medium" },
    });
  });
});

describe("generateCompactionEnvelope — pass accounting", () => {
  it("does not retry a facade result rejected by the domain schema", async () => {
    let attempt = 0;
    const outcome = await generateCompactionEnvelope(
      makeRequest(),
      deps(async (input) => {
        attempt += 1;
        if (attempt === 1) return structuredResult({ nonsense: true });
        return structuredResult(envelopeFromPrompt(sessionPrompt(input)));
      }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      passCount: 1,
      failure: { code: "schema_invalid" },
    });
    expect(calls).toHaveLength(1);
    expect(passes.map((pass) => [pass.kind, pass.outcome])).toEqual([
      ["initial", "schema"],
    ]);
  });

  it("resumes the latest facade session for one guard re-prompt", async () => {
    const outcome = await generateCompactionEnvelope(
      makeRequest(),
      deps(async (input) => {
        const envelope = envelopeFromPrompt(sessionPrompt(input));
        return structuredResult(
          calls.length === 1
            ? {
                ...envelope,
                source: { ...envelope.source, coveredEndSeq: 2 },
              }
            : envelope,
        );
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.resumeRef).toEqual({
      backend: "claude",
      ref: "latest-envelope-session",
    });
    expect(calls.map((call) => call.structuredOutputTurns)).toEqual([
      "work_then_format",
      "single",
    ]);
    expect(passes.map((pass) => pass.kind)).toEqual([
      "initial",
      "guard_repair",
    ]);
    // The session already holds the rendered transcript, so the correction
    // carries only the feedback and is measured as such.
    expect(calls[1]?.prompt).not.toContain("## Source metadata");
    expect(calls[1]?.prompt).toContain("violated deterministic guards");
    expect(passes[1]?.inputBytes).toBe(
      Buffer.byteLength(calls[1]?.prompt ?? "", "utf-8"),
    );
    expect(passes[1]?.inputBytes).toBeLessThan(passes[0]?.inputBytes ?? 0);
  });

  it.each(["missing", "cleared"] as const)(
    "does not restart a %s session to repair a guard failure",
    async (continuity) => {
      const outcome = await generateCompactionEnvelope(
        makeRequest(),
        deps(async (input) => {
          const envelope = envelopeFromPrompt(sessionPrompt(input));
          return {
            ...structuredResult({
              ...envelope,
              source: { ...envelope.source, coveredEndSeq: 2 },
            }),
            backendRef:
              continuity === "missing"
                ? null
                : { backend: "claude", ref: "unusable" },
            continuationDisposition:
              continuity === "cleared" ? "clear" : "retain",
          };
        }),
      );
      expect(outcome).toMatchObject({
        ok: false,
        passCount: 1,
        failure: { code: "guard_violations" },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("counts every fold segment as its own observed pass", async () => {
    const body = "a".repeat(200_000);
    const source = capturedSource([
      makeEntry(0, "user", body),
      makeEntry(1, "assistant", body),
      makeEntry(2, "user", body),
      makeEntry(3, "assistant", body),
    ]);
    const outcome = await generateCompactionEnvelope(
      makeRequest({ source }),
      deps(echo),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelope.source.coveredEndSeq).toBe(3);
    expect(outcome.passCount).toBe(2);
    expect(passes.map((pass) => pass.segment)).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ]);
    expect(passes.map((pass) => pass.mode)).toEqual(["full", "delta"]);
  });

  it.each(["full", "delta"] as const)(
    "keeps a %s fold fresh through the excluded capture tail",
    async (mode) => {
      const priorSource = capturedSource([makeEntry(0, "user", "prior task")]);
      const prior = await generateCompactionEnvelope(
        makeRequest({ source: priorSource }),
        deps(echo),
      );
      if (!prior.ok) throw new Error("prior envelope generation failed");
      calls = [];
      passes = [];

      const body = "a".repeat(200_000);
      const captureText = "excluded capture settlement";
      const source = capturedSource([
        ...priorSource.entries,
        makeEntry(1, "assistant", body),
        makeEntry(2, "user", body),
        makeEntry(3, "assistant", body),
        makeEntry(4, "user", body),
        {
          seq: 5,
          entryId: "capture-settlement",
          role: "notice",
          timestamp: "2026-01-01T00:00:00Z",
          content: [{ type: "text", text: captureText }],
          origin: {
            source: "checkpoint_capture",
            checkpointCapture: {
              operationId: "op",
              captureId: "op:capture",
              part: "settlement",
            },
          },
        },
      ]);
      const outcome = await generateCompactionEnvelope(
        makeRequest({
          source,
          plan: {
            mode,
            previousEnvelope: mode === "delta" ? prior.envelope : null,
            expected: { startSeq: 0, endSeq: source.capturedThroughSeq },
          },
        }),
        deps(echo),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.passCount).toBe(2);
      expect(calls.every((call) => !call.prompt.includes(captureText))).toBe(
        true,
      );
      expect(outcome.envelope.source.coveredStartSeq).toBe(0);
      expect(outcome.envelope.source.coveredEndSeq).toBe(
        source.capturedThroughSeq,
      );
      const versions = {
        promptVersion: "4",
        normalizerVersion: "2",
        schemaVersion: 1,
      };
      expect(
        deriveFreshness(
          {
            ...versions,
            coveredEndSeq: outcome.envelope.source.coveredEndSeq,
          },
          { ...versions, maxSeq: source.maxSeq },
        ).stale,
      ).toBe(false);
    },
  );

  it("fails with the oversize error when one message alone exceeds the budget", async () => {
    const source = capturedSource([
      makeEntry(0, "user", "x".repeat(COMPACTION_MODEL_BUDGET_BYTES + 100)),
    ]);
    const outcome = await generateCompactionEnvelope(
      makeRequest({ source }),
      deps(echo),
    );

    expect(outcome).toEqual({
      ok: false,
      error: OVERSIZE_RENDER_ERROR,
      failure: OVERSIZE_FAILURE,
      passCount: 0,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("generateCompactionEnvelope — cancellation", () => {
  it("refuses before any model call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await generateCompactionEnvelope(
      makeRequest(),
      deps(echo, controller.signal),
    );

    expect(outcome).toEqual({
      ok: false,
      error: CANCELLED_GENERATION_ERROR,
      failure: CANCELLED_FAILURE,
      passCount: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("hands the signal to the task runner so an in-flight pass is cancelled", async () => {
    const controller = new AbortController();
    await generateCompactionEnvelope(
      makeRequest(),
      deps(echo, controller.signal),
    );
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("stops folding when the signal aborts between segments", async () => {
    const controller = new AbortController();
    const body = "a".repeat(200_000);
    const source = capturedSource([
      makeEntry(0, "user", body),
      makeEntry(1, "assistant", body),
      makeEntry(2, "user", body),
      makeEntry(3, "assistant", body),
    ]);
    const outcome = await generateCompactionEnvelope(
      makeRequest({ source }),
      deps(async (input) => {
        controller.abort();
        return structuredResult(envelopeFromPrompt(sessionPrompt(input)));
      }, controller.signal),
    );

    expect(outcome).toEqual({
      ok: false,
      error: CANCELLED_GENERATION_ERROR,
      failure: CANCELLED_FAILURE,
      passCount: 1,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("generateCompactionEnvelope — failure diagnostics", () => {
  const DROPPED = "Alex approved shipping the widget before the demo";

  /** A real generated envelope, then a live decision the delta must keep. */
  async function previousEnvelopeWithDecision(): Promise<CompactionEnvelope> {
    const seed = await generateCompactionEnvelope(makeRequest(), deps(echo));
    if (!seed.ok) throw new Error("seed generation failed");
    return {
      ...seed.envelope,
      decisions: [
        {
          statement: DROPPED,
          status: "accepted",
          sourceRefs: [
            { messageIndex: 0, messageId: "entry-0", seqStart: 0, seqEnd: 1 },
          ],
        },
      ],
    };
  }

  /**
   * The dropped-decision guard is the one whose repair message must quote the
   * envelope — so it is the one that decides whether a log can echo the
   * conversation. Two delta passes fail it before the full fallback rescues
   * the run; both warnings are inspected.
   */
  it("logs guard codes and coordinates, never the dropped decision", async () => {
    const previous = await previousEnvelopeWithDecision();
    const source = capturedSource();
    vi.clearAllMocks();

    await generateCompactionEnvelope(
      makeRequest({
        source,
        plan: {
          mode: "delta",
          previousEnvelope: previous,
          expected: { startSeq: 0, endSeq: source.maxSeq },
        },
      }),
      deps(echo),
    );

    const guardLogs = logSpies.warn.mock.calls.filter(
      ([event]) => event === "artifact.delta.guard_failed",
    );
    expect(guardLogs).toHaveLength(2);
    for (const [, fields] of guardLogs) {
      expect(JSON.stringify(fields)).not.toContain("widget");
      expect(fields.violations).toEqual([
        "delta_decision_dropped@previous.decisions[0]",
      ]);
    }
  });

  it("gives the separate full fallback its own guard re-prompt and latest continuity", async () => {
    const previous = await previousEnvelopeWithDecision();
    calls = [];
    passes = [];
    const outcome = await generateCompactionEnvelope(
      makeRequest({
        plan: {
          mode: "delta",
          previousEnvelope: previous,
          expected: { startSeq: 0, endSeq: 3 },
        },
      }),
      deps(async (input) => {
        const envelope = envelopeFromPrompt(sessionPrompt(input));
        return {
          ...structuredResult(
            calls.length === 3
              ? {
                  ...envelope,
                  source: { ...envelope.source, coveredEndSeq: 2 },
                }
              : envelope,
          ),
          backendRef: { backend: "claude", ref: `pass-${calls.length}` },
        };
      }),
    );

    expect(outcome).toMatchObject({ ok: true, mode: "full", passCount: 4 });
    expect(calls.map((call) => call.resumeRef)).toEqual([
      undefined,
      { backend: "claude", ref: "pass-1" },
      undefined,
      { backend: "claude", ref: "pass-3" },
    ]);
    expect(calls.map((call) => call.structuredOutputTurns)).toEqual([
      "work_then_format",
      "single",
      "work_then_format",
      "single",
    ]);
    expect(passes.map((pass) => pass.kind)).toEqual([
      "initial",
      "guard_repair",
      "full_fallback",
      "guard_repair",
    ]);
  });

  /** A guard the full fallback cannot rescue, so the run reports its failure. */
  const shortCoverage = async (input: ExecuteWorkflowTaskRunInput) => {
    const envelope = envelopeFromPrompt(sessionPrompt(input));
    return structuredResult({
      ...envelope,
      source: {
        ...envelope.source,
        coveredEndSeq: envelope.source.coveredEndSeq - 1,
      },
    });
  };

  it("reports a structural failure the caller can log without redaction", async () => {
    const outcome = await generateCompactionEnvelope(
      makeRequest(),
      deps(shortCoverage),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({
      code: "guard_violations",
      segment: null,
      at: ["coverage_end_mismatch@source.coveredEndSeq"],
      failureKind: null,
    });
  });

  it("classifies a backend failure by kind rather than by its text", async () => {
    const outcome = await generateCompactionEnvelope(
      makeRequest(),
      deps(async () => ({
        kind: "error",
        error: `provider refused: the prompt quoted "${DROPPED}"`,
        aborted: false,
        failure: {
          kind: "quota_exhausted",
          message: "slow down",
          retryable: true,
        },
        usage: USAGE,
        backendRef: null,
        continuationDisposition: "retain",
      })),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({
      code: "model_error",
      segment: null,
      at: [],
      failureKind: "quota_exhausted",
    });
    expect(JSON.stringify(outcome.failure)).not.toContain("widget");
  });
});
