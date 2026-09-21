/**
 * Captured-source envelope generation: the model-facing half of compaction,
 * separated from the artifact row that used to own it.
 *
 * The artifact service still owns freshness, single-flight, and the rolling
 * row; this module owns one run over ONE immutable transcript snapshot —
 * render, redact, prompt, execute, guard re-prompt, and the sequential
 * delta fold. Checkpoint generation reuses it against a captured archive
 * boundary, which is why the source arrives as a value rather than as a
 * transcript path this module could re-read between passes, and why the lane
 * (worktree included) is supplied by the caller rather than derived from the
 * project's registered checkout.
 */

import { createHash } from "node:crypto";

import { createLogger, type Logger } from "@/lib/logging";
import {
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
  segmentTranscript,
  NORMALIZER_VERSION,
  type RenderOptions,
  type RenderedTranscript,
  type TranscriptSegment,
} from "@/lib/conversations/transcript-render";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import type {
  ConversationAddress,
  ConversationBinding,
} from "@/lib/workflows/conversation/turn-spec";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  TaskRunResult,
  TaskRunUsage,
} from "@/lib/workflows/conversation/turn-result";

import {
  buildCompactionPrompt,
  COMPACTION_JSON_SCHEMA,
  compactionStructuredOutputSchema,
  PROMPT_VERSION,
  type CompactionSourceMeta,
} from "./generation";
import {
  validateCompactionGuards,
  type CompactionGuardViolation,
  type CompactionRunMode,
} from "./guards";
import { redactEnvelopeStrings } from "./redaction";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ArtifactKind,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";

const genLogger = createLogger("context-artifacts.generation");

/**
 * Hard bound on a single compaction render (tools summarized, thinking
 * stripped). A whole-conversation render past this is compacted with the
 * sequential delta-fold path (docs/design/conversation-compaction/README.md
 * §7.3): the transcript is split into `SEGMENT_WINDOW_BUDGET_BYTES` windows
 * folded through the existing delta-merge contract. A single message that
 * alone exceeds this budget still fails with `OVERSIZE_RENDER_ERROR` —
 * folding a lone unit cannot help.
 */
export const COMPACTION_MODEL_BUDGET_BYTES = 600_000;

/**
 * Headroom reserved below the model budget for the previous-envelope JSON each
 * delta fold step carries in its prompt, so a step's transcript window plus its
 * carried envelope stays within the same envelope of safety as a single pass.
 */
const CARRIED_ENVELOPE_RESERVE_BYTES = 120_000;

/**
 * Per-segment transcript-render budget for the delta-fold path — kept below
 * `COMPACTION_MODEL_BUDGET_BYTES` so a delta step's carried previous envelope
 * fits alongside the segment's rendered lines.
 */
export const SEGMENT_WINDOW_BUDGET_BYTES =
  COMPACTION_MODEL_BUDGET_BYTES - CARRIED_ENVELOPE_RESERVE_BYTES;

export const OVERSIZE_RENDER_ERROR = "transcript_too_large_for_single_pass";
export const CANCELLED_GENERATION_ERROR = "generation_cancelled";

/**
 * One immutable transcript snapshot. `capturedThroughSeq` records the raw JSONL
 * line boundary the caller read through, so a later build over a different
 * boundary is a different basis even when the rendered window matches.
 */
export interface CapturedTranscriptSource {
  conversationId: string;
  entries: TranscriptEntryWithSeq[];
  maxSeq: number;
  capturedThroughSeq: number;
}

export interface EnvelopeGenerationPlan {
  mode: CompactionRunMode;
  /** Set when mode === "delta". */
  previousEnvelope: CompactionEnvelope | null;
  /** Coverage the run is expected to produce. */
  expected: { startSeq: number; endSeq: number };
}

/**
 * Where the synthetic compaction lane executes. Supplied whole because the
 * worktree a checkpoint compacts in is the target's resolved worktree, which
 * is not derivable from the project path this module could see.
 */
export interface EnvelopeGenerationLane {
  address: ConversationAddress;
  worktreePath: string;
  backend: Extract<ConversationBinding, { kind: "ephemeral" }>["backend"];
}

export interface EnvelopeGenerationRequest {
  /** Correlation id for this run's diagnostics. */
  runId: string;
  kind: ArtifactKind;
  /** Required for `message_compaction`; null otherwise. */
  messageIndex: number | null;
  projectName: string;
  /** null for project-scope conversations. */
  sessionName: string | null;
  source: CapturedTranscriptSource;
  plan: EnvelopeGenerationPlan;
  lane: EnvelopeGenerationLane;
  modelSelection: BackendModelSelection;
  timeoutMs: number;
}

export type EnvelopePassKind = "initial" | "guard_repair" | "full_fallback";

/** One facade call. Usage includes its format and schema-repair turns. */
export interface EnvelopeGenerationPass {
  /** 1-based across the whole run, including folds and repairs. */
  index: number;
  kind: EnvelopePassKind;
  mode: CompactionRunMode;
  /** 1-based fold position, or null for a single-pass run. */
  segment: { index: number; total: number } | null;
  inputBytes: number;
  /** The runner's nullable counters; a backend that reports none leaves it null. */
  usage: TaskRunUsage | null;
  outcome: "ok" | "schema" | "guard" | "model";
}

export interface EnvelopeGenerationDeps {
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  /** Observes every facade call, including folds and guard re-prompts. */
  onPass?(pass: EnvelopeGenerationPass): void;
  /** Cancels the run; checked before each pass and handed to the runner. */
  signal?: AbortSignal;
  log?: Logger;
}

/**
 * Why a run failed, in codes and coordinates only.
 *
 * `error` beside it is prose: it reaches the artifact row a reader sees, and a
 * provider's own sentence about a rate limit belongs there. This is the half a
 * checkpoint may log, where an echo of the envelope or the prompt would break
 * the no-source-text rule (R9.2).
 */
export interface EnvelopeGenerationFailure {
  code:
    | "cancelled"
    | "oversize_render"
    | "model_error"
    | "schema_invalid"
    | "guard_violations"
    | "no_segments";
  /** 1-based fold segment the failure fell in, or null for a single-pass run. */
  segment: number | null;
  /**
   * Coordinates behind `code`: `<guard code>@<field path>` for a guard
   * failure, refused instance paths for a schema failure, empty otherwise.
   */
  at: string[];
  /** The runner's neutral classification of a model failure, when it gave one. */
  failureKind: string | null;
}

export type EnvelopeGenerationOutcome =
  | {
      ok: true;
      envelope: CompactionEnvelope;
      sourceHash: string;
      inputBytes: number;
      mode: CompactionRunMode;
      passCount: number;
    }
  | {
      ok: false;
      error: string;
      failure: EnvelopeGenerationFailure;
      passCount: number;
    };

export function isArtifactVersionCurrent(row: ContextArtifactRow): boolean {
  return (
    row.promptVersion === PROMPT_VERSION &&
    row.normalizerVersion === NORMALIZER_VERSION &&
    row.schemaVersion === CONTEXT_ARTIFACT_SCHEMA_VERSION
  );
}

/**
 * A full-conversation render includes every entry — including a trailing
 * tool_result line past the last visible entry (`maxSeq`). Coverage must
 * claim every rendered seq or the §7.3 sourceRef guard would reject a
 * citation of those lines; staleness stays maxSeq-derived, so the wider
 * claim never marks the artifact stale.
 */
export function lastRenderedSeq(
  entries: TranscriptEntryWithSeq[],
  maxSeq: number,
): number {
  const last = entries[entries.length - 1];
  return last ? Math.max(maxSeq, last.seq) : maxSeq;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Fully-resolved description of one model pass's render window + coverage. */
interface PassPrep {
  mode: CompactionRunMode;
  previousEnvelope: CompactionEnvelope | null;
  /** Explicit seq window; null renders the whole snapshot (or the message). */
  window: { seqStart: number; seqEnd: number } | null;
  expected: { startSeq: number; endSeq: number };
  allowTruncation: boolean;
}

interface PreparedRun {
  prompt: string;
  expected: { startSeq: number; endSeq: number };
  sourceHash: string;
  inputBytes: number;
  /** True when the render hit maxBytes; only tolerated on fold segments. */
  truncated: boolean;
}

type ModelPassResult =
  | { status: "ok"; envelope: CompactionEnvelope }
  | { status: "schema"; detail: string; paths: string[] }
  | {
      status: "guard";
      violations: CompactionGuardViolation[];
      resumeRef: AgentSessionRef | null;
    }
  | { status: "model"; error: string; failureKind: string | null };

type PassOutcome =
  | {
      ok: true;
      envelope: CompactionEnvelope;
      sourceHash: string;
      inputBytes: number;
      mode: CompactionRunMode;
    }
  | { ok: false; error: string; failure: EnvelopeGenerationFailure };

/** A failure with no coordinates and no fold position — the common shape. */
function plainFailure(
  code: EnvelopeGenerationFailure["code"],
): EnvelopeGenerationFailure {
  return { code, segment: null, at: [], failureKind: null };
}

/** `code@path` — the loggable half of a guard violation. */
function guardCoordinate(violation: CompactionGuardViolation): string {
  return `${violation.code}@${violation.at}`;
}

class OversizeRenderError extends Error {
  constructor() {
    super(OVERSIZE_RENDER_ERROR);
  }
}

class CancelledGenerationError extends Error {
  constructor() {
    super(CANCELLED_GENERATION_ERROR);
  }
}

function renderForSpec(
  request: EnvelopeGenerationRequest,
  spec: PassPrep,
): RenderedTranscript {
  const { source } = request;
  const windowOptions: Record<string, unknown> = {};
  if (request.kind === "message_compaction") {
    windowOptions["message"] = request.messageIndex;
  } else if (spec.window !== null) {
    windowOptions["seqRange"] = [spec.window.seqStart, spec.window.seqEnd];
  }
  const options: RenderOptions = renderOptionsSchema.parse({
    includeTools: "summary",
    includeThinking: false,
    maxBytes: COMPACTION_MODEL_BUDGET_BYTES,
    ...windowOptions,
  });
  return renderCompactTranscript(
    {
      conversationId: source.conversationId,
      entries: source.entries,
      maxSeq: source.maxSeq,
      evidenceOnly: true,
    },
    options,
  );
}

function prepareRun(
  request: EnvelopeGenerationRequest,
  spec: PassPrep,
): PreparedRun {
  const rendered = renderForSpec(request, spec);
  if (rendered.truncated && !spec.allowTruncation) {
    throw new OversizeRenderError();
  }

  const redactedRendered = redactEnvelopeStrings(rendered);
  const markdown = renderedTranscriptToMarkdown(redactedRendered);
  const sourceHash = sha256(markdown);

  const sourceMeta: CompactionSourceMeta = {
    projectName: request.projectName,
    sessionName: request.sessionName,
    conversationId: request.source.conversationId,
    coveredStartSeq: spec.expected.startSeq,
    coveredEndSeq: spec.expected.endSeq,
    messageCount: rendered.totalMessages,
    sourceHash,
  };

  const prompt =
    spec.mode === "delta" && spec.previousEnvelope !== null
      ? buildCompactionPrompt({
          mode: "delta",
          kind: request.kind,
          sourceMeta,
          previousEnvelope: spec.previousEnvelope,
          deltaRenderedTranscript: redactedRendered,
        })
      : buildCompactionPrompt({
          mode: "full",
          kind: request.kind,
          sourceMeta,
          renderedTranscript: redactedRendered,
        });

  return {
    prompt,
    expected: spec.expected,
    sourceHash,
    inputBytes: Buffer.byteLength(prompt, "utf-8"),
    truncated: rendered.truncated,
  };
}

/** The single-pass render window + coverage for the planned mode. */
function specFor(
  request: EnvelopeGenerationRequest,
  mode: CompactionRunMode,
): PassPrep {
  const { plan, source } = request;
  if (request.kind === "message_compaction") {
    return {
      mode: "full",
      previousEnvelope: null,
      window: null,
      expected: plan.expected,
      allowTruncation: false,
    };
  }
  if (mode === "delta" && plan.previousEnvelope !== null) {
    return {
      mode: "delta",
      previousEnvelope: plan.previousEnvelope,
      window: {
        seqStart: plan.previousEnvelope.source.coveredEndSeq + 1,
        seqEnd: source.maxSeq,
      },
      expected: plan.expected,
      allowTruncation: false,
    };
  }
  return {
    mode: "full",
    previousEnvelope: null,
    window: null,
    expected: {
      startSeq: source.entries[0]?.seq ?? 0,
      endSeq: lastRenderedSeq(source.entries, source.maxSeq),
    },
    allowTruncation: false,
  };
}

/**
 * Mutable per-run accounting. Pass count is the operation's measured cost, so
 * it counts every facade call — fold steps and guard re-prompts included — and survives
 * a failure so the caller can record what was spent.
 */
interface RunState {
  passCount: number;
}

export async function generateCompactionEnvelope(
  request: EnvelopeGenerationRequest,
  deps: EnvelopeGenerationDeps,
): Promise<EnvelopeGenerationOutcome> {
  const log = deps.log ?? genLogger;
  const state: RunState = { passCount: 0 };

  function throwIfCancelled(): void {
    if (deps.signal?.aborted === true) throw new CancelledGenerationError();
  }

  /** One facade call: execute → schema-parse → deterministic guards. */
  async function attemptModelPass(
    prompt: string,
    mode: CompactionRunMode,
    expected: { startSeq: number; endSeq: number },
    previousEnvelope: CompactionEnvelope | null,
    pass: {
      kind: EnvelopePassKind;
      segment: { index: number; total: number } | null;
      inputBytes: number;
    },
    resumeRef?: AgentSessionRef,
  ): Promise<ModelPassResult> {
    throwIfCancelled();
    const result = await deps.executeTaskRun({
      kind: "task_run",
      executionClass: "nongoverned-task",
      executionProfile: "standard",
      // The work turn summarizes in prose; the guard correction resumes that
      // session and is already a format request.
      structuredOutputTurns: resumeRef ? "single" : "work_then_format",
      ...(resumeRef ? { resumeRef } : {}),
      prompt,
      outputFormat: { type: "json_schema", schema: COMPACTION_JSON_SCHEMA },
      timeoutMs: request.timeoutMs,
      modelSelection: request.modelSelection,
      binding: {
        address: request.lane.address,
        // No ConversationState record exists for this synthetic lane, so the
        // ephemeral persistence adapter makes every durable side effect inert:
        // derived-field sync, snapshot persistence, and read/unread transitions
        // all no-op instead of failing `Conversation not found in session`.
        kind: "ephemeral",
        worktreePath: request.lane.worktreePath,
        backend: request.lane.backend,
        role: null,
        transcriptPath: null,
      },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });

    state.passCount += 1;
    const observed = (outcome: EnvelopeGenerationPass["outcome"]): void => {
      deps.onPass?.({
        index: state.passCount,
        kind: pass.kind,
        mode,
        segment: pass.segment,
        inputBytes: pass.inputBytes,
        usage: result.usage,
        outcome,
      });
    };

    if (
      result.kind === "error" &&
      result.structuredOutputIssues !== undefined
    ) {
      observed("schema");
      return {
        status: "schema",
        detail: result.structuredOutputIssues.join("; "),
        paths: ["(structured output refused)"],
      };
    }
    if (result.kind === "error") {
      observed("model");
      return {
        status: "model",
        error: result.error,
        failureKind: result.failure?.kind ?? null,
      };
    }

    const parsed =
      result.kind === "structured"
        ? compactionStructuredOutputSchema.safeParse(result.structuredOutput)
        : null;
    if (parsed === null || !parsed.success) {
      const detail =
        parsed === null
          ? "the response contained no structured output"
          : parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ");
      const paths =
        parsed === null
          ? ["(no structured output)"]
          : parsed.error.issues.map(
              (issue) => `${issue.path.join(".") || "(root)"}[${issue.code}]`,
            );
      observed("schema");
      return { status: "schema", detail, paths };
    }

    const guard = validateCompactionGuards(parsed.data, {
      mode,
      ...(mode === "delta" && previousEnvelope !== null
        ? { previousEnvelope }
        : {}),
      expectedCoverage: expected,
    });
    if (!guard.ok) {
      observed("guard");
      return {
        status: "guard",
        violations: guard.violations,
        resumeRef:
          result.continuationDisposition === "retain"
            ? result.backendRef
            : null,
      };
    }
    observed("ok");
    return { status: "ok", envelope: parsed.data };
  }

  /** The facade owns schema repair; guards may request one contextual correction. */
  async function runPass(
    prepared: PreparedRun,
    mode: CompactionRunMode,
    previousEnvelope: CompactionEnvelope | null,
    segment: { index: number; total: number } | null,
    kind: EnvelopePassKind = "initial",
  ): Promise<PassOutcome> {
    const observeGuard = (
      attempt: Extract<ModelPassResult, { status: "guard" }>,
    ): void => {
      log.warn(
        segment ? "artifact.fold.guard_failed" : "artifact.delta.guard_failed",
        {
          runId: request.runId,
          conversationId: request.source.conversationId,
          kind: request.kind,
          ...(segment ? { segment: segment.index, of: segment.total } : {}),
          mode,
          violations: attempt.violations.map(guardCoordinate),
        },
      );
    };
    let attempt = await attemptModelPass(
      prepared.prompt,
      mode,
      prepared.expected,
      previousEnvelope,
      { kind, segment, inputBytes: prepared.inputBytes },
    );
    if (attempt.status === "guard") {
      observeGuard(attempt);
      if (attempt.resumeRef !== null) {
        // The resumed session already holds the rendered transcript and the
        // envelope contract; only the feedback is new.
        const prompt = `Your previous envelope violated deterministic guards:\n- ${attempt.violations.map((violation) => violation.message).join("\n- ")}\nCorrect the envelope using the same captured evidence and respond with the complete corrected envelope.`;
        attempt = await attemptModelPass(
          prompt,
          mode,
          prepared.expected,
          previousEnvelope,
          {
            kind: "guard_repair",
            segment,
            inputBytes: Buffer.byteLength(prompt, "utf-8"),
          },
          attempt.resumeRef,
        );
        if (attempt.status === "guard") observeGuard(attempt);
      }
    }
    if (attempt.status === "model") {
      return {
        ok: false,
        error: attempt.error,
        failure: {
          ...plainFailure("model_error"),
          failureKind: attempt.failureKind,
        },
      };
    }
    if (attempt.status === "schema") {
      return {
        ok: false,
        error: `envelope failed schema validation: ${attempt.detail}`,
        failure: { ...plainFailure("schema_invalid"), at: attempt.paths },
      };
    }
    if (attempt.status === "guard") {
      return {
        ok: false,
        error: `envelope failed deterministic guards: ${attempt.violations.map((violation) => violation.message).join("; ")}`,
        failure: {
          ...plainFailure("guard_violations"),
          at: attempt.violations.map(guardCoordinate),
        },
      };
    }
    return {
      ok: true,
      envelope: attempt.envelope,
      sourceHash: prepared.sourceHash,
      inputBytes: prepared.inputBytes,
      mode,
    };
  }

  /** A delta guard refusal may start one independent full-mode call. */
  async function runSinglePass(): Promise<PassOutcome> {
    const mode = request.plan.mode;
    const outcome = await runPass(
      prepareRun(request, specFor(request, mode)),
      mode,
      mode === "delta" ? request.plan.previousEnvelope : null,
      null,
    );
    if (
      !outcome.ok &&
      outcome.failure.code === "guard_violations" &&
      mode === "delta"
    ) {
      return runPass(
        prepareRun(request, specFor(request, "full")),
        "full",
        null,
        null,
        "full_fallback",
      );
    }
    return outcome;
  }

  /**
   * Decide whether a conversation compaction must be folded. Returns the
   * segments when the planned single-pass render is oversize AND splits into
   * ≥2 unit-aligned windows; null otherwise (single pass, or a lone oversize
   * message that folding cannot help).
   */
  function planFold(): TranscriptSegment[] | null {
    if (request.kind !== "conversation_compaction") return null;
    const spec = specFor(request, request.plan.mode);
    const probe = renderForSpec(request, spec);
    if (!probe.truncated) return null;

    const segOptions = renderOptionsSchema.parse({
      includeTools: "summary",
      includeThinking: false,
      maxBytes: COMPACTION_MODEL_BUDGET_BYTES,
      ...(spec.window !== null
        ? { seqRange: [spec.window.seqStart, spec.window.seqEnd] }
        : {}),
    });
    const segments = segmentTranscript(
      {
        conversationId: request.source.conversationId,
        entries: request.source.entries,
        maxSeq: request.source.maxSeq,
        evidenceOnly: true,
      },
      segOptions,
      SEGMENT_WINDOW_BUDGET_BYTES,
    );
    return segments.length >= 2 ? segments : null;
  }

  /**
   * Sequential delta-fold (§7.3): render each segment within budget and merge
   * it into the running envelope — the first step is a full compaction (unless
   * seeded by an existing envelope for a delta refresh), every later step is a
   * delta whose previous envelope is the prior step's result. Coverage stays
   * anchored at the conversation start and extends monotonically to each
   * segment's end; the last step's envelope covers the whole snapshot.
   */
  async function runFold(segments: TranscriptSegment[]): Promise<PassOutcome> {
    const seededPrevious =
      request.plan.mode === "delta" ? request.plan.previousEnvelope : null;
    const coverageStart =
      seededPrevious !== null
        ? seededPrevious.source.coveredStartSeq
        : (request.source.entries[0]?.seq ?? 0);

    log.info("artifact.fold.started", {
      runId: request.runId,
      conversationId: request.source.conversationId,
      mode: request.plan.mode,
      segments: segments.length,
      coverageStart,
    });

    let previous: CompactionEnvelope | null = seededPrevious;
    let sourceHash = "";
    let inputBytes = 0;
    const finalCoverageEnd = specFor(request, request.plan.mode).expected
      .endSeq;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      // Filtered capture records still belong to the frozen source coverage.
      // The last fold must cover that tail without feeding it to the model.
      const endSeq = i === segments.length - 1 ? finalCoverageEnd : seg.seqEnd;
      const stepMode: CompactionRunMode = previous === null ? "full" : "delta";
      const windowStart =
        previous === null ? seg.seqStart : previous.source.coveredEndSeq + 1;
      const prepared = prepareRun(request, {
        mode: stepMode,
        previousEnvelope: previous,
        window: { seqStart: windowStart, seqEnd: endSeq },
        expected: { startSeq: coverageStart, endSeq },
        allowTruncation: true,
      });
      const step = await runPass(prepared, stepMode, previous, {
        index: i + 1,
        total: segments.length,
      });
      if (!step.ok) {
        return {
          ok: false,
          error: `segment ${i + 1}/${segments.length}: ${step.error}`,
          failure: { ...step.failure, segment: i + 1 },
        };
      }
      previous = step.envelope;
      sourceHash = prepared.sourceHash;
      inputBytes = prepared.inputBytes;
      log.info("artifact.fold.segment_completed", {
        runId: request.runId,
        conversationId: request.source.conversationId,
        segment: i + 1,
        of: segments.length,
        coveredEndSeq: endSeq,
      });
    }

    if (previous === null) {
      return {
        ok: false,
        error: "segmentation produced no segments",
        failure: plainFailure("no_segments"),
      };
    }
    return {
      ok: true,
      envelope: previous,
      sourceHash,
      inputBytes,
      mode: request.plan.mode,
    };
  }

  try {
    throwIfCancelled();
    const segments = planFold();
    const outcome = segments ? await runFold(segments) : await runSinglePass();
    return outcome.ok
      ? { ...outcome, passCount: state.passCount }
      : {
          ok: false,
          error: outcome.error,
          failure: outcome.failure,
          passCount: state.passCount,
        };
  } catch (err) {
    if (err instanceof OversizeRenderError) {
      return {
        ok: false,
        error: OVERSIZE_RENDER_ERROR,
        failure: plainFailure("oversize_render"),
        passCount: state.passCount,
      };
    }
    if (err instanceof CancelledGenerationError) {
      return {
        ok: false,
        error: CANCELLED_GENERATION_ERROR,
        failure: plainFailure("cancelled"),
        passCount: state.passCount,
      };
    }
    throw err;
  }
}
