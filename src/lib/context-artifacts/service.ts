/**
 * Compaction generation service (docs/design/conversation-compaction/README.md
 * §7.1, §7.2): self-contained background execution — the artifact row is the
 * job record and `context_artifact_status` SSE is the progress channel. No
 * jobs-table involvement.
 *
 * The model call runs on a SYNTHETIC TRANSIENT actor lane (the graph-workflow
 * validator precedent): never the target conversation's real actor, so
 * compaction cannot contend with live turns and always honors the configured
 * compaction backend/model instead of the conversation's own.
 */

import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import {
  groupTranscriptEntries,
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
  segmentTranscript,
  NORMALIZER_VERSION,
  type RenderOptions,
  type RenderedTranscript,
  type TranscriptSegment,
} from "@/lib/conversations/transcript-render";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { CompactionConfig } from "@/lib/config/schemas";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  buildCompactionPrompt,
  COMPACTION_JSON_SCHEMA,
  compactionStructuredOutputSchema,
  PROMPT_VERSION,
  type CompactionSourceMeta,
} from "./generation";
import { validateCompactionGuards, type CompactionRunMode } from "./guards";
import { redactEnvelopeStrings } from "./redaction";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ArtifactKind,
  type CompactionEnvelope,
  type ContextArtifactCreatedBy,
  type ContextArtifactRow,
  type ContextArtifactScope,
  type ContextArtifactStatusEvent,
} from "./schemas";
import type { ContextArtifactsRepo } from "./repo";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("context-artifacts");
const genLogger = createLogger("context-artifacts.generation");
const auditLogger = createLogger("context-artifacts.audit");

/**
 * Hard bound on a single compaction render (tools summarized, thinking
 * stripped). A whole-conversation render past this is compacted with the
 * sequential delta-fold path (docs/design/conversation-compaction/README.md
 * §7.3): the transcript is split into `SEGMENT_WINDOW_BUDGET_BYTES` windows
 * folded through the existing delta-merge contract. A single message that
 * alone exceeds this budget still fails with
 * `transcript_too_large_for_single_pass` — folding a lone unit cannot help.
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

export interface CompactionServiceDeps {
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  readEntries(transcriptPath: string | null): Promise<TranscriptEntriesResult>;
  repo: ContextArtifactsRepo;
  resolveConfig(projectPath: string): Promise<CompactionConfig>;
  broadcast(event: SSEEvent): void;
  /** ISO-8601 timestamp source. */
  now(): string;
}

export interface TriggerCompactionInput {
  kind: ArtifactKind;
  scope: ContextArtifactScope;
  projectPath: string;
  projectName: string;
  /** null for project-scope conversations. */
  sessionName: string | null;
  conversationId: string;
  transcriptPath: string | null;
  /** Required for `message_compaction`. */
  messageIndex?: number;
  /** Regenerate from scratch even when the artifact is fresh. */
  force?: boolean;
  createdBy: ContextArtifactCreatedBy;
  createdByConversationId?: string | null;
  /** Audit tag naming the trigger surface (e.g. "ui_api", "agent_api"). */
  trigger: string;
}

export type TriggerCompactionResult =
  | {
      outcome: "started";
      artifactId: string;
      timeoutMs: number;
      completion: Promise<ContextArtifactRow>;
    }
  | {
      outcome: "coalesced";
      artifactId: string;
      timeoutMs: number;
      completion: Promise<ContextArtifactRow>;
    }
  | { outcome: "already_fresh"; artifact: ContextArtifactRow }
  | { outcome: "invalid"; error: string };

export interface CompactionService {
  trigger(input: TriggerCompactionInput): Promise<TriggerCompactionResult>;
}

interface InFlightRun {
  artifactId: string;
  timeoutMs: number;
  completion: Promise<ContextArtifactRow>;
}

interface GenerationPlan {
  mode: CompactionRunMode;
  /** Set when mode === "delta" (complete previous artifact with payload). */
  previousEnvelope: CompactionEnvelope | null;
  previousCoveredStartSeq: number | null;
  messageId: string | null;
  /** Coverage the initial run is expected to produce. */
  expected: { startSeq: number; endSeq: number };
}

function flightKey(input: TriggerCompactionInput): string {
  return `${input.conversationId}::${input.kind}::${input.messageIndex ?? ""}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * A full-conversation render includes every entry — including a trailing
 * tool_result line past the last visible entry (`maxSeq`). Coverage must
 * claim every rendered seq or the §7.3 sourceRef guard would reject a
 * citation of those lines; staleness stays maxSeq-derived, so the wider
 * claim never marks the artifact stale.
 */
function lastRenderedSeq(
  entries: TranscriptEntryWithSeq[],
  maxSeq: number,
): number {
  const last = entries[entries.length - 1];
  return last ? Math.max(maxSeq, last.seq) : maxSeq;
}

function isVersionCurrent(row: ContextArtifactRow): boolean {
  return (
    row.promptVersion === PROMPT_VERSION &&
    row.normalizerVersion === NORMALIZER_VERSION &&
    row.schemaVersion === CONTEXT_ARTIFACT_SCHEMA_VERSION
  );
}

export function createCompactionService(
  deps: CompactionServiceDeps,
): CompactionService {
  const inFlight = new Map<string, InFlightRun>();
  // Per-key trigger serialization (§7.2): `runTrigger` awaits transcript and
  // config reads before it registers the in-flight run, so a truly concurrent
  // trigger for the same slot must queue behind the first one's setup to see
  // the registration and coalesce instead of starting a second generation.
  const triggerMutex = createKeyedMutex();

  function statusEvent(
    input: TriggerCompactionInput,
    artifactId: string,
    status: ContextArtifactRow["status"],
    error?: string,
  ): ContextArtifactStatusEvent {
    const payload = {
      type: "context_artifact_status" as const,
      conversationId: input.conversationId,
      artifactId,
      kind: input.kind,
      status,
      ...(input.messageIndex !== undefined
        ? { messageIndex: input.messageIndex }
        : {}),
      ...(error !== undefined ? { error } : {}),
    };
    if (input.scope === "session" && input.sessionName !== null) {
      return {
        ...payload,
        scope: "session",
        projectName: input.projectName,
        sessionName: input.sessionName,
      };
    }
    return { ...payload, scope: "project", projectName: input.projectName };
  }

  function findConversationArtifact(
    conversationId: string,
  ): ContextArtifactRow | null {
    return (
      deps.repo
        .findByConversation(conversationId)
        .find((row) => row.kind === "conversation_compaction") ?? null
    );
  }

  function planRun(
    input: TriggerCompactionInput,
    entries: TranscriptEntryWithSeq[],
    maxSeq: number,
    existing: ContextArtifactRow | null,
  ): GenerationPlan | { error: string } {
    if (input.kind === "message_compaction") {
      if (input.messageIndex === undefined) {
        return { error: "messageIndex is required for message_compaction" };
      }
      const units = groupTranscriptEntries(entries);
      const unit = units[input.messageIndex];
      if (!unit) {
        return {
          error: `message index ${input.messageIndex} is out of range (conversation has ${units.length} messages)`,
        };
      }
      const firstPart = unit.parts[0];
      const lastPart = unit.parts[unit.parts.length - 1];
      if (!firstPart || !lastPart) {
        return { error: `message index ${input.messageIndex} has no entries` };
      }
      return {
        mode: "full",
        previousEnvelope: null,
        previousCoveredStartSeq: null,
        messageId: unit.messageId,
        expected: { startSeq: firstPart.seq, endSeq: lastPart.seq },
      };
    }

    const firstEntry = entries[0];
    if (!firstEntry) {
      return { error: "transcript is empty; nothing to compact" };
    }

    const canDelta =
      input.force !== true &&
      existing !== null &&
      existing.status === "complete" &&
      existing.payload !== null &&
      isVersionCurrent(existing) &&
      maxSeq > existing.coveredEndSeq;

    if (canDelta && existing !== null && existing.payload !== null) {
      return {
        mode: "delta",
        previousEnvelope: existing.payload,
        previousCoveredStartSeq: existing.coveredStartSeq,
        messageId: null,
        expected: { startSeq: existing.coveredStartSeq, endSeq: maxSeq },
      };
    }

    return {
      mode: "full",
      previousEnvelope: null,
      previousCoveredStartSeq: null,
      messageId: null,
      expected: {
        startSeq: firstEntry.seq,
        endSeq: lastRenderedSeq(entries, maxSeq),
      },
    };
  }

  interface PreparedRun {
    prompt: string;
    expected: { startSeq: number; endSeq: number };
    sourceHash: string;
    inputBytes: number;
    /** True when the render hit maxBytes; only tolerated on fold segments. */
    truncated: boolean;
  }

  /** Fully-resolved description of one model pass's render window + coverage. */
  interface PassPrep {
    mode: CompactionRunMode;
    previousEnvelope: CompactionEnvelope | null;
    /** Explicit seq window; null renders the whole transcript (or the message). */
    window: { seqStart: number; seqEnd: number } | null;
    expected: { startSeq: number; endSeq: number };
    allowTruncation: boolean;
  }

  type ModelPassResult =
    | { status: "ok"; envelope: CompactionEnvelope }
    | { status: "schema"; detail: string }
    | { status: "guard"; violations: string[] }
    | { status: "model"; error: string };

  type PassOutcome =
    | {
        ok: true;
        envelope: CompactionEnvelope;
        sourceHash: string;
        inputBytes: number;
        mode: CompactionRunMode;
      }
    | { ok: false; error: string };

  interface RunContext {
    input: TriggerCompactionInput;
    artifactId: string;
    baseRow: ContextArtifactRow;
    plan: GenerationPlan;
    entries: TranscriptEntryWithSeq[];
    maxSeq: number;
    config: CompactionConfig;
    model: string;
  }

  class OversizeRenderError extends Error {
    constructor() {
      super("transcript_too_large_for_single_pass");
    }
  }

  function renderForSpec(ctx: RunContext, spec: PassPrep): RenderedTranscript {
    const { input, entries, maxSeq } = ctx;
    const windowOptions: Record<string, unknown> = {};
    if (input.kind === "message_compaction") {
      windowOptions["message"] = input.messageIndex;
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
      { conversationId: input.conversationId, entries, maxSeq },
      options,
    );
  }

  function prepareRun(ctx: RunContext, spec: PassPrep): PreparedRun {
    const { input } = ctx;

    const rendered = renderForSpec(ctx, spec);
    if (rendered.truncated && !spec.allowTruncation) {
      throw new OversizeRenderError();
    }

    const redactedRendered = redactEnvelopeStrings(rendered);
    const markdown = renderedTranscriptToMarkdown(redactedRendered);
    const sourceHash = sha256(markdown);

    const sourceMeta: CompactionSourceMeta = {
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      coveredStartSeq: spec.expected.startSeq,
      coveredEndSeq: spec.expected.endSeq,
      messageCount: rendered.totalMessages,
      sourceHash,
    };

    const prompt =
      spec.mode === "delta" && spec.previousEnvelope !== null
        ? buildCompactionPrompt({
            mode: "delta",
            kind: input.kind,
            sourceMeta,
            previousEnvelope: spec.previousEnvelope,
            deltaRenderedTranscript: redactedRendered,
          })
        : buildCompactionPrompt({
            mode: "full",
            kind: input.kind,
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
  function specFor(ctx: RunContext, mode: CompactionRunMode): PassPrep {
    if (ctx.input.kind === "message_compaction") {
      return {
        mode: "full",
        previousEnvelope: null,
        window: null,
        expected: ctx.plan.expected,
        allowTruncation: false,
      };
    }
    if (mode === "delta" && ctx.plan.previousEnvelope !== null) {
      return {
        mode: "delta",
        previousEnvelope: ctx.plan.previousEnvelope,
        window: {
          seqStart: ctx.plan.previousEnvelope.source.coveredEndSeq + 1,
          seqEnd: ctx.maxSeq,
        },
        expected: ctx.plan.expected,
        allowTruncation: false,
      };
    }
    return {
      mode: "full",
      previousEnvelope: null,
      window: null,
      expected: {
        startSeq: ctx.entries[0]?.seq ?? 0,
        endSeq: lastRenderedSeq(ctx.entries, ctx.maxSeq),
      },
      allowTruncation: false,
    };
  }

  /** Append rejection feedback to a prompt for a retry attempt. */
  function withFeedback(prompt: string, feedback: string | null): string {
    if (feedback === null) return prompt;
    return `${prompt}\n\n## Previous attempt rejected\n${feedback}\nRespond again with a single corrected JSON envelope.`;
  }

  const schemaFeedback = (detail: string): string =>
    `Your previous response violated the output JSON schema: ${detail}`;

  const guardFeedback = (violations: string[]): string =>
    `Your previous response violated deterministic envelope guards:\n- ${violations.join("\n- ")}`;

  /** One model call: execute → schema-parse → deterministic guards. No retry. */
  async function attemptModelPass(
    ctx: RunContext,
    prompt: string,
    mode: CompactionRunMode,
    expected: { startSeq: number; endSeq: number },
    previousEnvelope: CompactionEnvelope | null,
  ): Promise<ModelPassResult> {
    const { input, artifactId, config, model } = ctx;
    const laneSessionName =
      input.sessionName ?? PROJECT_CONVERSATION_SESSION_SENTINEL;
    const result = await deps.executeTaskRun({
      projectPath: input.projectPath,
      sessionName: laneSessionName,
      conversationId: `compaction-${artifactId}`,
      kind: "task_run",
      prompt,
      outputFormat: { type: "json_schema", schema: COMPACTION_JSON_SCHEMA },
      timeoutMs: resolveConfiguredTimeoutMs(config.timeoutMs),
      modelId: model,
      effort: config.effort,
      actorInput: {
        projectName: input.projectName,
        sessionWorktreePath: input.projectPath,
        // No ConversationState record exists for this synthetic lane, so the
        // ephemeral persistence adapter makes every durable side effect inert:
        // derived-field sync, snapshot persistence, and read/unread transitions
        // all no-op instead of failing `Conversation not found in session`.
        persistence: "ephemeral",
        conversation: {
          createdAt: deps.now(),
          forkedFrom: null,
          role: null,
          transcriptPath: null,
          agentBackend: config.backend,
          backendRef: null,
          promptCount: 0,
          debugMode: null,
        },
      },
    });

    if (result.kind === "error") {
      return { status: "model", error: result.error };
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
      return { status: "schema", detail };
    }

    const guard = validateCompactionGuards(parsed.data, {
      mode,
      ...(mode === "delta" && previousEnvelope !== null
        ? { previousEnvelope }
        : {}),
      expectedCoverage: expected,
    });
    if (!guard.ok) {
      return { status: "guard", violations: guard.violations };
    }
    return { status: "ok", envelope: parsed.data };
  }

  /**
   * Single-pass generation: one render of the whole planned window, with the
   * schema/guard retry loop and the delta→full guard fallback (§7.3). Throws
   * `OversizeRenderError` when the render exceeds the model budget so the caller
   * can decide between the fold path and a hard failure.
   */
  async function runSinglePass(ctx: RunContext): Promise<PassOutcome> {
    const preparedByMode = new Map<CompactionRunMode, PreparedRun>();
    const prepared = (mode: CompactionRunMode): PreparedRun => {
      const cached = preparedByMode.get(mode);
      if (cached) return cached;
      const fresh = prepareRun(ctx, specFor(ctx, mode));
      preparedByMode.set(mode, fresh);
      return fresh;
    };

    let mode = ctx.plan.mode;
    let schemaRetryUsed = false;
    let guardRetryUsed = false;
    let feedback: string | null = null;

    for (;;) {
      const run = prepared(mode);
      const attempt = await attemptModelPass(
        ctx,
        withFeedback(run.prompt, feedback),
        mode,
        run.expected,
        mode === "delta" ? ctx.plan.previousEnvelope : null,
      );

      if (attempt.status === "model")
        return { ok: false, error: attempt.error };

      if (attempt.status === "schema") {
        if (!schemaRetryUsed) {
          schemaRetryUsed = true;
          feedback = schemaFeedback(attempt.detail);
          continue;
        }
        return {
          ok: false,
          error: `envelope failed schema validation after retry: ${attempt.detail}`,
        };
      }

      if (attempt.status === "guard") {
        genLogger.warn("artifact.delta.guard_failed", {
          artifactId: ctx.artifactId,
          conversationId: ctx.input.conversationId,
          kind: ctx.input.kind,
          mode,
          violations: attempt.violations,
        });
        if (!guardRetryUsed) {
          guardRetryUsed = true;
          feedback = guardFeedback(attempt.violations);
          continue;
        }
        if (mode === "delta") {
          // Second delta guard failure → ONE full non-delta fallback run
          // (§7.3); retries stay consumed so the fallback is single-shot.
          mode = "full";
          feedback = null;
          continue;
        }
        return {
          ok: false,
          error: `envelope failed deterministic guards: ${attempt.violations.join("; ")}`,
        };
      }

      return {
        ok: true,
        envelope: attempt.envelope,
        sourceHash: run.sourceHash,
        inputBytes: run.inputBytes,
        mode,
      };
    }
  }

  /**
   * Decide whether a conversation compaction must be folded. Returns the
   * segments when the planned single-pass render is oversize AND splits into
   * ≥2 unit-aligned windows; null otherwise (single pass, or a lone oversize
   * message that folding cannot help).
   */
  function planFold(ctx: RunContext): TranscriptSegment[] | null {
    if (ctx.input.kind !== "conversation_compaction") return null;
    const spec = specFor(ctx, ctx.plan.mode);
    const probe = renderForSpec(ctx, spec);
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
        conversationId: ctx.input.conversationId,
        entries: ctx.entries,
        maxSeq: ctx.maxSeq,
      },
      segOptions,
      SEGMENT_WINDOW_BUDGET_BYTES,
    );
    return segments.length >= 2 ? segments : null;
  }

  /** Retry loop for one fold step — schema + guard retries, no full fallback. */
  async function runFoldStep(
    ctx: RunContext,
    prepared: PreparedRun,
    mode: CompactionRunMode,
    previousEnvelope: CompactionEnvelope | null,
    segIndex: number,
    segTotal: number,
  ): Promise<
    { ok: true; envelope: CompactionEnvelope } | { ok: false; error: string }
  > {
    let schemaRetryUsed = false;
    let guardRetryUsed = false;
    let feedback: string | null = null;

    for (;;) {
      const attempt = await attemptModelPass(
        ctx,
        withFeedback(prepared.prompt, feedback),
        mode,
        prepared.expected,
        previousEnvelope,
      );

      if (attempt.status === "model")
        return { ok: false, error: attempt.error };

      if (attempt.status === "schema") {
        if (!schemaRetryUsed) {
          schemaRetryUsed = true;
          feedback = schemaFeedback(attempt.detail);
          continue;
        }
        return {
          ok: false,
          error: `envelope failed schema validation after retry: ${attempt.detail}`,
        };
      }

      if (attempt.status === "guard") {
        genLogger.warn("artifact.fold.guard_failed", {
          artifactId: ctx.artifactId,
          conversationId: ctx.input.conversationId,
          segment: segIndex + 1,
          of: segTotal,
          mode,
          violations: attempt.violations,
        });
        if (!guardRetryUsed) {
          guardRetryUsed = true;
          feedback = guardFeedback(attempt.violations);
          continue;
        }
        return {
          ok: false,
          error: `envelope failed deterministic guards: ${attempt.violations.join("; ")}`,
        };
      }

      return { ok: true, envelope: attempt.envelope };
    }
  }

  /**
   * Sequential delta-fold (§7.3): render each segment within budget and merge
   * it into the running envelope — the first step is a full compaction (unless
   * seeded by an existing artifact for a delta refresh), every later step is a
   * delta whose previous envelope is the prior step's result. Coverage stays
   * anchored at the conversation start and extends monotonically to each
   * segment's end; the last step's envelope covers the whole transcript.
   */
  async function runFold(
    ctx: RunContext,
    segments: TranscriptSegment[],
  ): Promise<PassOutcome> {
    const seededPrevious =
      ctx.plan.mode === "delta" ? ctx.plan.previousEnvelope : null;
    const coverageStart =
      seededPrevious !== null
        ? seededPrevious.source.coveredStartSeq
        : (ctx.entries[0]?.seq ?? 0);

    genLogger.info("artifact.fold.started", {
      artifactId: ctx.artifactId,
      conversationId: ctx.input.conversationId,
      mode: ctx.plan.mode,
      segments: segments.length,
      coverageStart,
    });

    let previous: CompactionEnvelope | null = seededPrevious;
    let sourceHash = "";
    let inputBytes = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const stepMode: CompactionRunMode = previous === null ? "full" : "delta";
      const windowStart =
        previous === null ? seg.seqStart : previous.source.coveredEndSeq + 1;
      const prepared = prepareRun(ctx, {
        mode: stepMode,
        previousEnvelope: previous,
        window: { seqStart: windowStart, seqEnd: seg.seqEnd },
        expected: { startSeq: coverageStart, endSeq: seg.seqEnd },
        allowTruncation: true,
      });
      const step = await runFoldStep(
        ctx,
        prepared,
        stepMode,
        previous,
        i,
        segments.length,
      );
      if (!step.ok) {
        return {
          ok: false,
          error: `segment ${i + 1}/${segments.length}: ${step.error}`,
        };
      }
      previous = step.envelope;
      sourceHash = prepared.sourceHash;
      inputBytes = prepared.inputBytes;
      genLogger.info("artifact.fold.segment_completed", {
        artifactId: ctx.artifactId,
        conversationId: ctx.input.conversationId,
        segment: i + 1,
        of: segments.length,
        coveredEndSeq: seg.seqEnd,
      });
    }

    if (previous === null) {
      return { ok: false, error: "segmentation produced no segments" };
    }
    return {
      ok: true,
      envelope: previous,
      sourceHash,
      inputBytes,
      mode: ctx.plan.mode,
    };
  }

  function persistSuccess(
    ctx: RunContext,
    outcome: {
      envelope: CompactionEnvelope;
      sourceHash: string;
      inputBytes: number;
      mode: CompactionRunMode;
    },
    startedAt: number,
  ): ContextArtifactRow {
    const redactedEnvelope = redactEnvelopeStrings(outcome.envelope);
    const completedAt = deps.now();
    const finalRow: ContextArtifactRow = {
      ...ctx.baseRow,
      coveredStartSeq: redactedEnvelope.source.coveredStartSeq,
      coveredEndSeq: redactedEnvelope.source.coveredEndSeq,
      sourceHash: outcome.sourceHash,
      status: "complete",
      error: null,
      payload: redactedEnvelope,
      updatedAt: completedAt,
    };
    // Per-column update, not upsert: a row deleted mid-generation must stay
    // deleted, so the completion write no-ops (and skips the broadcast) when
    // the row is gone.
    const persisted = deps.repo.updateChangedColumns(ctx.artifactId, {
      coveredStartSeq: finalRow.coveredStartSeq,
      coveredEndSeq: finalRow.coveredEndSeq,
      sourceHash: finalRow.sourceHash,
      status: finalRow.status,
      error: finalRow.error,
      payload: finalRow.payload,
      updatedAt: finalRow.updatedAt,
    });
    if (!persisted) {
      genLogger.warn("artifact.generation.discarded_row_deleted", {
        artifactId: ctx.artifactId,
        conversationId: ctx.input.conversationId,
        kind: ctx.input.kind,
        durationMs: Date.now() - startedAt,
      });
      return finalRow;
    }
    deps.broadcast(statusEvent(ctx.input, ctx.artifactId, "complete"));
    genLogger.info("artifact.generation.completed", {
      artifactId: ctx.artifactId,
      conversationId: ctx.input.conversationId,
      kind: ctx.input.kind,
      mode: outcome.mode,
      model: ctx.model,
      durationMs: Date.now() - startedAt,
      inputBytes: outcome.inputBytes,
      outputBytes: Buffer.byteLength(JSON.stringify(redactedEnvelope), "utf-8"),
      coverage: {
        startSeq: finalRow.coveredStartSeq,
        endSeq: finalRow.coveredEndSeq,
      },
    });
    return finalRow;
  }

  async function runGeneration(ctx: RunContext): Promise<ContextArtifactRow> {
    const { input, artifactId, config, model } = ctx;
    const startedAt = Date.now();

    genLogger.info("artifact.generation.started", {
      artifactId,
      conversationId: input.conversationId,
      kind: input.kind,
      mode: ctx.plan.mode,
      backend: config.backend,
      model,
      messageIndex: input.messageIndex ?? null,
    });

    function failRun(error: string): ContextArtifactRow {
      const failedAt = deps.now();
      deps.repo.updateChangedColumns(artifactId, {
        status: "failed",
        error,
        updatedAt: failedAt,
      });
      deps.broadcast(statusEvent(input, artifactId, "failed", error));
      genLogger.error("artifact.generation.failed", {
        artifactId,
        conversationId: input.conversationId,
        kind: input.kind,
        model,
        durationMs: Date.now() - startedAt,
        error,
      });
      return {
        ...ctx.baseRow,
        status: "failed",
        error,
        updatedAt: failedAt,
      };
    }

    try {
      const segments = planFold(ctx);
      const outcome = segments
        ? await runFold(ctx, segments)
        : await runSinglePass(ctx);
      if (!outcome.ok) return failRun(outcome.error);
      return persistSuccess(ctx, outcome, startedAt);
    } catch (err) {
      if (err instanceof OversizeRenderError) {
        return failRun("transcript_too_large_for_single_pass");
      }
      return failRun(getErrorMessage(err));
    }
  }

  function trigger(
    input: TriggerCompactionInput,
  ): Promise<TriggerCompactionResult> {
    const key = flightKey(input);
    return triggerMutex.run(key, () => runTrigger(input, key));
  }

  async function runTrigger(
    input: TriggerCompactionInput,
    key: string,
  ): Promise<TriggerCompactionResult> {
    logger.info("artifact.requested", {
      kind: input.kind,
      trigger: input.trigger,
      createdBy: input.createdBy,
      conversationId: input.conversationId,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      messageIndex: input.messageIndex ?? null,
      force: input.force === true,
    });
    auditLogger.info("audit.compaction_triggered", {
      callerConversationId: input.createdByConversationId ?? null,
      targetConversationId: input.conversationId,
      trigger: input.trigger,
    });

    const running = inFlight.get(key);
    if (running) {
      return {
        outcome: "coalesced",
        artifactId: running.artifactId,
        timeoutMs: running.timeoutMs,
        completion: running.completion,
      };
    }

    const { entries, maxSeq } = await deps.readEntries(input.transcriptPath);

    const existing =
      input.kind === "message_compaction"
        ? input.messageIndex !== undefined
          ? deps.repo.findMessageArtifact(
              input.conversationId,
              input.messageIndex,
            )
          : null
        : findConversationArtifact(input.conversationId);

    if (
      input.force !== true &&
      existing !== null &&
      existing.status === "complete"
    ) {
      // Message artifacts are coverage-fresh forever: transcripts are
      // append-only, so a message's own lines never change (§16 open item 1).
      // Conversation artifacts are coverage-fresh while coverage reaches
      // maxSeq. Either kind refreshes on generator version drift — the
      // API/CLI `outdated` hint points callers at a plain (non-force) compact.
      const fresh =
        (input.kind === "message_compaction" ||
          maxSeq <= existing.coveredEndSeq) &&
        isVersionCurrent(existing);
      if (fresh) {
        return { outcome: "already_fresh", artifact: existing };
      }
    }

    const plan = planRun(input, entries, maxSeq, existing);
    if ("error" in plan) {
      return { outcome: "invalid", error: plan.error };
    }

    const config = await deps.resolveConfig(input.projectPath);
    const model =
      input.kind === "conversation_compaction"
        ? config.conversationModel
        : config.messageModel;
    const nowIso = deps.now();
    const artifactId = existing?.id ?? randomUUID();

    const baseRow: ContextArtifactRow = {
      id: artifactId,
      kind: input.kind,
      scope: input.scope,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      messageId: plan.messageId ?? existing?.messageId ?? null,
      messageIndex: input.messageIndex ?? null,
      // A pre-existing row keeps its achieved coverage until the run
      // succeeds: the coverage columns must never claim seqs the retained
      // payload does not cover (failRun leaves them untouched, and freshness
      // derivation reads them without a status guard).
      coveredStartSeq: existing?.coveredStartSeq ?? plan.expected.startSeq,
      coveredEndSeq: existing?.coveredEndSeq ?? plan.expected.endSeq,
      sourceHash: existing?.sourceHash ?? "",
      status: "pending",
      error: null,
      modelProvider: config.backend,
      model,
      effort: config.effort,
      schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      createdBy: input.createdBy,
      createdByConversationId: input.createdByConversationId ?? null,
      payload: existing?.payload ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    deps.repo.upsert(baseRow);
    deps.broadcast(statusEvent(input, artifactId, "pending"));

    const ctx: RunContext = {
      input,
      artifactId,
      baseRow,
      plan,
      entries,
      maxSeq,
      config,
      model,
    };
    const completion = runGeneration(ctx).finally(() => {
      if (inFlight.get(key)?.completion === completion) {
        inFlight.delete(key);
      }
    });
    const resolvedTimeoutMs = resolveConfiguredTimeoutMs(config.timeoutMs);
    inFlight.set(key, { artifactId, timeoutMs: resolvedTimeoutMs, completion });

    return {
      outcome: "started",
      artifactId,
      timeoutMs: resolvedTimeoutMs,
      completion,
    };
  }

  return { trigger };
}
