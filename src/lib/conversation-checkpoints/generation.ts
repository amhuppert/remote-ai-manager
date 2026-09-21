/**
 * Checkpoint generation: captured source in, immutable payload out.
 *
 * This is the owned call checkpoint-maintenance invokes under the conversation
 * manager's reservation. It never runs a turn on the source conversation — the
 * archive is supplied as data to a synthetic compaction lane — and it returns
 * a payload only when the rendered seed already satisfies every budget, so a
 * failed build cannot leave an invalid payload behind.
 */

import { z } from "zod";

import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { CompactionConfig } from "@/lib/config/schemas";
import { createLogger, type Logger } from "@/lib/logging";
import {
  generateCompactionEnvelope,
  COMPACTION_MODEL_BUDGET_BYTES,
  type EnvelopeGenerationLane,
  type EnvelopeGenerationPass,
} from "@/lib/context-artifacts/envelope-generation";
import { redactEnvelopeStrings } from "@/lib/context-artifacts/redaction";
import type {
  CompactionEnvelope,
  ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import {
  NORMALIZER_VERSION,
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
} from "@/lib/conversations/transcript-render";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  TaskRunResult,
  TaskRunUsage,
} from "@/lib/workflows/conversation/turn-result";

import {
  buildCheckpointSeed,
  checkpointWorkingStateSchema,
  CHECKPOINT_NOT_ESTABLISHED,
  type CheckpointBuildIssue,
  type CheckpointSeedIdentity,
  type BuiltCheckpointSeed,
} from "./builder";
import { CHECKPOINT_BUILDER_VERSION } from "./budget";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  EMPTY_CHECKPOINT_USAGE,
  type CheckpointFailure,
  type CheckpointHandoffCandidate,
  type CheckpointPayload,
  type CheckpointUsage,
} from "./schemas";
import { decideEnvelopeReuse, type CapturedCheckpointSource } from "./source";

/** Bumped when the working-state prompt or its schema changes. */
export const CHECKPOINT_GENERATOR_VERSION = "4";

export interface GenerateCheckpointInput {
  /** Current validated capture only; never supplied to evidence generation. */
  agentHandoff?: CheckpointHandoffCandidate;
  identity: CheckpointSeedIdentity;
  source: CapturedCheckpointSource;
  /** The conversation's current reading artifact, when it has one. */
  existingArtifact: ContextArtifactRow | null;
  /** Resolved execution context — the target's worktree, not the checkout. */
  lane: EnvelopeGenerationLane;
  config: CompactionConfig;
  createdAt: string;
}

export interface GenerateCheckpointDeps {
  executeTaskRun(input: ExecuteWorkflowTaskRunInput): Promise<TaskRunResult>;
  /** Owned cancellation signal; checkpoint-maintenance holds the controller. */
  signal?: AbortSignal;
  onPass?(pass: EnvelopeGenerationPass): void;
  log?: Logger;
}

export interface CheckpointGenerationTelemetry {
  /** Every facade call: envelope folds, guard re-prompts, and seed passes. */
  generationPassCount: number;
  usage: CheckpointUsage;
}

export type GenerateCheckpointResult =
  | ({
      ok: true;
      payload: CheckpointPayload;
      handoffDecision?: "included" | "seed_budget";
    } & CheckpointGenerationTelemetry)
  | ({ ok: false; failure: CheckpointFailure } & CheckpointGenerationTelemetry);

const checkpointLogger = createLogger("conversation-checkpoints");

/**
 * Raw-line window of the archive tail handed to the working-state pass
 * alongside the whole-conversation envelope. The envelope already carries the
 * conversation; the tail is what keeps the newest exchanges verbatim in the
 * generator's view.
 */
const WORKING_STATE_TAIL_SEQ_WINDOW = 200;
const WORKING_STATE_TAIL_BUDGET_BYTES = 120_000;

const CHECKPOINT_WORKING_STATE_JSON_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(checkpointWorkingStateSchema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === "object") {
        jsonSchema.additionalProperties = false;
      }
    },
  });

const WORKING_STATE_INSTRUCTIONS = [
  "You are extracting the checkpoint working state of a coding-agent conversation for Command Center.",
  "Work in prose first: cover every property of the checkpoint working state schema below, with the sourceRefs each entry needs. A follow-up turn will ask you to emit the working state as a single JSON object conforming to that schema.",
  "",
  "Rules:",
  "- Report only what the supplied evidence establishes. Never invent a decision, outcome, path, or approval.",
  `- When a required field has no recorded evidence, write exactly "${CHECKPOINT_NOT_ESTABLISHED}" for a text field with an empty sourceRefs array, and an empty array for a list.`,
  "- Every factual entry MUST cite sourceRefs with the narrowest supporting raw-sequence range, objective and latestRequest included. Copy messageIndex and seq coordinates from the unit headers (`#<messageIndex> [seq A–B] <role>`) and the per-line `[s<seq>]` prefixes.",
  "- A sourceRef must stay inside ONE logical message: its seqStart and seqEnd must both be lines of the message it names. A range spanning several messages, or naming a seq that message does not contain, is rejected.",
  "- decisions carry their status: proposed, accepted, rejected, or superseded. Keep a rejected or superseded decision rather than dropping it.",
  "- failedApproaches record what was tried and what actually happened, not what should be tried next.",
  "- This is historical evidence for a successor agent. Do not assert that anything is currently approved, validated, or true of the worktree now.",
].join("\n");

/**
 * Fold one pass's counters into the operation total.
 *
 * A counter is a measurement of the whole operation or it is nothing: if any
 * pass failed to report cost, the sum of the rest is a subtotal, and reporting
 * a subtotal as the operation's cost understates the spend with nothing marking
 * the gap. So a missing counter makes the total unavailable (R9.3), on its own
 * axis — one backend reporting tokens but not cost keeps its token total. The
 * per-pass `checkpoint.generation.pass` log still carries what was measured.
 *
 * `total` is null before the first pass, which is why an operation that made no
 * model call reports unavailable rather than zero.
 */
function foldUsage(
  total: CheckpointUsage | null,
  usage: TaskRunUsage | null,
): CheckpointUsage {
  const pass = usage ?? EMPTY_CHECKPOINT_USAGE;
  if (total === null) {
    return {
      inputTokens: pass.inputTokens,
      cachedInputTokens: pass.cachedInputTokens,
      outputTokens: pass.outputTokens,
      costUsd: pass.costUsd,
      durationMs: pass.durationMs,
    };
  }
  const add = (current: number | null, next: number | null): number | null =>
    current === null || next === null ? null : current + next;
  return {
    inputTokens: add(total.inputTokens, pass.inputTokens),
    cachedInputTokens: add(total.cachedInputTokens, pass.cachedInputTokens),
    outputTokens: add(total.outputTokens, pass.outputTokens),
    costUsd: add(total.costUsd, pass.costUsd),
    durationMs: add(total.durationMs, pass.durationMs),
  };
}

function renderArchiveTail(source: CapturedCheckpointSource): string {
  const start = Math.max(
    source.firstSeq,
    source.basis.capturedThroughSeq - WORKING_STATE_TAIL_SEQ_WINDOW,
  );
  const rendered = renderCompactTranscript(
    {
      conversationId: source.captured.conversationId,
      entries: source.captured.entries,
      evidenceOnly: true,
      maxSeq: source.captured.maxSeq,
    },
    renderOptionsSchema.parse({
      includeTools: "summary",
      includeThinking: false,
      maxBytes: Math.min(
        WORKING_STATE_TAIL_BUDGET_BYTES,
        COMPACTION_MODEL_BUDGET_BYTES,
      ),
      seqRange: [start, source.basis.capturedThroughSeq],
    }),
  );
  return renderedTranscriptToMarkdown(redactEnvelopeStrings(rendered));
}

function buildWorkingStatePrompt(
  source: CapturedCheckpointSource,
  envelope: CompactionEnvelope,
): string {
  return [
    WORKING_STATE_INSTRUCTIONS,
    "",
    "## Checkpoint working state schema (enforced on the follow-up format turn)",
    "```json",
    JSON.stringify(CHECKPOINT_WORKING_STATE_JSON_SCHEMA),
    "```",
    "",
    "## Source boundary",
    `Conversation ${source.captured.conversationId}, recorded archive lines ${source.firstSeq}-${source.basis.capturedThroughSeq} (${source.totalMessages} messages). Every sourceRef must fall inside that range.`,
    "",
    "## Conversation envelope",
    "```json",
    JSON.stringify(envelope),
    "```",
    "",
    "## Recent archive tail",
    renderArchiveTail(source),
  ].join("\n");
}

function issueFeedback(issues: CheckpointBuildIssue[]): string {
  return `Your previous checkpoint working state was rejected:\n- ${issues
    .map((issue) => `${issue.code}: ${issue.detail}`)
    .join("\n- ")}`;
}

type WorkingStateAttempt =
  | { status: "ok"; seed: BuiltCheckpointSeed }
  | {
      status: "guard";
      issues: CheckpointBuildIssue[];
      resumeRef: AgentSessionRef | null;
    }
  | { status: "schema"; paths: string[] }
  | { status: "cancelled" }
  | { status: "model"; failureKind: string | null };

/**
 * Structural cause of a failed build, for the diagnostic that records it.
 * Codes and coordinates only: what a model returned and what a backend said
 * are the two things a checkpoint log may not repeat (R9.2).
 */
interface GenerationDiagnostic {
  cause:
    | "cancelled"
    | "model_error"
    | "schema_invalid"
    | "guard_violations"
    | "oversize_render"
    | "no_segments"
    | "working_state_invalid";
  at?: string[];
  failureKind?: string | null;
  segment?: number | null;
}

export async function generateCheckpoint(
  input: GenerateCheckpointInput,
  deps: GenerateCheckpointDeps,
): Promise<GenerateCheckpointResult> {
  const log = deps.log ?? checkpointLogger;
  const { identity, source, config, lane } = input;
  const modelSelection = config.conversationModelSelection;
  const timeoutMs = resolveConfiguredTimeoutMs(config.timeoutMs);

  let passCount = 0;
  let usage: CheckpointUsage | null = null;

  /**
   * Every facade call this build makes — envelope folds, guard re-prompts, and the
   * working-state passes — is both summed into the operation's usage and
   * logged. The fields are shapes and counters only: an input size rather than
   * the prompt, a pass kind rather than the feedback that provoked it.
   */
  const observe = (pass: EnvelopeGenerationPass): void => {
    usage = foldUsage(usage, pass.usage);
    log.info("checkpoint.generation.pass", {
      conversationId: identity.conversationId,
      operationId: identity.checkpointId,
      index: pass.index,
      kind: pass.kind,
      mode: pass.mode,
      segmentIndex: pass.segment?.index ?? null,
      segmentTotal: pass.segment?.total ?? null,
      inputBytes: pass.inputBytes,
      outcome: pass.outcome,
      inputTokens: pass.usage?.inputTokens ?? null,
      cachedInputTokens: pass.usage?.cachedInputTokens ?? null,
      outputTokens: pass.usage?.outputTokens ?? null,
      costUsd: pass.usage?.costUsd ?? null,
      durationMs: pass.usage?.durationMs ?? null,
    });
    deps.onPass?.(pass);
  };

  const telemetry = (): CheckpointGenerationTelemetry => ({
    generationPassCount: passCount,
    usage: usage ?? EMPTY_CHECKPOINT_USAGE,
  });

  /**
   * `failure` rides into the public checkpoint receipt and `diagnostic` into
   * the log, and both are structural — codes, field paths, coordinates, byte
   * counts. Neither carries the text a model produced or a backend returned:
   * a receipt is public, and a log line is no safer, because the sentence a
   * provider hands back can quote the prompt or name the session it failed on.
   */
  const fail = (
    code: string,
    message: string,
    diagnostic: GenerationDiagnostic,
  ): GenerateCheckpointResult => {
    log.warn("checkpoint.generation.failed", {
      conversationId: identity.conversationId,
      operationId: identity.checkpointId,
      code,
      generationPassCount: passCount,
      ...diagnostic,
    });
    return { ok: false, failure: { code, message }, ...telemetry() };
  };

  if (deps.signal?.aborted === true) {
    return fail("cancelled", "checkpoint generation was cancelled", {
      cause: "cancelled",
    });
  }

  // The boundary this build is bound to, recorded before any model call: a
  // later failure is then attributable to a known snapshot rather than to
  // "whatever the archive held at the time".
  log.info("checkpoint.source.captured", {
    conversationId: identity.conversationId,
    operationId: identity.checkpointId,
    ordinal: identity.ordinal,
    firstSeq: source.firstSeq,
    capturedThroughSeq: source.basis.capturedThroughSeq,
    sourceHash: source.basis.sourceHash,
    totalMessages: source.totalMessages,
    entryCount: source.captured.entries.length,
  });

  const reuse = decideEnvelopeReuse(input.existingArtifact, source);
  let envelope: CompactionEnvelope;
  if (reuse.reusable) {
    envelope = reuse.envelope;
    log.info("checkpoint.source.envelope_reused", {
      conversationId: identity.conversationId,
      operationId: identity.checkpointId,
      artifactId: reuse.provenance.artifactId,
      capturedThroughSeq: source.basis.capturedThroughSeq,
    });
  } else {
    log.info("checkpoint.source.envelope_regenerating", {
      conversationId: identity.conversationId,
      operationId: identity.checkpointId,
      reason: reuse.reason,
      capturedThroughSeq: source.basis.capturedThroughSeq,
    });
    const generated = await generateCompactionEnvelope(
      {
        runId: identity.checkpointId,
        kind: "conversation_compaction",
        messageIndex: null,
        projectName: lane.address.target.projectName,
        sessionName:
          lane.address.target.scope === "session"
            ? lane.address.target.sessionName
            : null,
        source: source.captured,
        plan: {
          mode: "full",
          previousEnvelope: null,
          expected: {
            startSeq: source.firstSeq,
            endSeq: source.basis.capturedThroughSeq,
          },
        },
        lane,
        modelSelection,
        timeoutMs,
      },
      {
        executeTaskRun: deps.executeTaskRun,
        onPass: observe,
        ...(deps.signal ? { signal: deps.signal } : {}),
        log,
      },
    );
    passCount += generated.passCount;
    if (!generated.ok) {
      return generated.failure.code === "cancelled"
        ? fail("cancelled", "checkpoint generation was cancelled", {
            cause: "cancelled",
          })
        : fail(
            "envelope_generation_failed",
            "the conversation envelope could not be generated from the captured source",
            {
              cause: generated.failure.code,
              at: generated.failure.at,
              failureKind: generated.failure.failureKind,
              segment: generated.failure.segment,
            },
          );
    }
    envelope = generated.envelope;
  }

  async function attemptWorkingState(
    prompt: string,
    passKind: EnvelopeGenerationPass["kind"],
    resumeRef?: AgentSessionRef,
  ): Promise<WorkingStateAttempt> {
    if (deps.signal?.aborted ?? false) return { status: "cancelled" };
    const result = await deps.executeTaskRun({
      kind: "task_run",
      executionClass: "nongoverned-task",
      executionProfile: "standard",
      // The work turn extracts in prose; the seed-check correction resumes
      // that session and is already a format request.
      structuredOutputTurns: resumeRef ? "single" : "work_then_format",
      ...(resumeRef ? { resumeRef } : {}),
      prompt,
      outputFormat: {
        type: "json_schema",
        schema: CHECKPOINT_WORKING_STATE_JSON_SCHEMA,
      },
      timeoutMs,
      modelSelection,
      binding: {
        kind: "ephemeral",
        address: lane.address,
        worktreePath: lane.worktreePath,
        backend: lane.backend,
        role: null,
        transcriptPath: null,
      },
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    passCount += 1;

    const emit = (outcome: EnvelopeGenerationPass["outcome"]): void => {
      observe({
        index: passCount,
        kind: passKind,
        mode: "full",
        segment: null,
        inputBytes: Buffer.byteLength(prompt, "utf-8"),
        usage: result.usage,
        outcome,
      });
    };

    if (
      result.kind === "error" &&
      result.structuredOutputIssues !== undefined
    ) {
      emit("schema");
      return { status: "schema", paths: ["(structured output refused)"] };
    }
    if (result.kind === "error") {
      emit("model");
      return { status: "model", failureKind: result.failure?.kind ?? null };
    }
    const parsed =
      result.kind === "structured"
        ? checkpointWorkingStateSchema.safeParse(result.structuredOutput)
        : null;
    if (parsed === null || !parsed.success) {
      emit("schema");
      return parsed === null
        ? {
            status: "schema",
            paths: ["(no structured output)"],
          }
        : {
            status: "schema",
            paths: parsed.error.issues.map(
              (issue) => `${issue.path.join(".") || "(root)"}[${issue.code}]`,
            ),
          };
    }
    const build = buildCheckpointSeed({
      identity,
      source: {
        firstSeq: source.firstSeq,
        capturedThroughSeq: source.basis.capturedThroughSeq,
        totalMessages: source.totalMessages,
      },
      workingState: parsed.data,
      ...(input.agentHandoff !== undefined
        ? { agentHandoff: input.agentHandoff }
        : {}),
      entries: source.captured.entries,
    });
    if (!build.ok) {
      emit("guard");
      return {
        status: "guard",
        issues: build.issues,
        resumeRef:
          result.continuationDisposition === "retain"
            ? result.backendRef
            : null,
      };
    }
    emit("ok");
    return { status: "ok", seed: build.seed };
  }

  let attempt = await attemptWorkingState(
    buildWorkingStatePrompt(source, envelope),
    "initial",
  );
  if (attempt.status === "guard" && attempt.resumeRef !== null) {
    attempt = await attemptWorkingState(
      `${issueFeedback(attempt.issues)}\nCorrect the checkpoint working state using the same captured evidence.`,
      "guard_repair",
      attempt.resumeRef,
    );
  }
  if (attempt.status === "cancelled") {
    return fail("cancelled", "checkpoint generation was cancelled", {
      cause: "cancelled",
    });
  }
  if (attempt.status === "model") {
    return fail(
      "working_state_model_error",
      "the checkpoint working-state pass did not complete",
      { cause: "model_error", failureKind: attempt.failureKind },
    );
  }
  if (attempt.status === "schema") {
    return fail(
      "working_state_schema",
      `the checkpoint working state did not satisfy its schema (${attempt.paths.join(", ")})`,
      { cause: "schema_invalid", at: attempt.paths },
    );
  }
  if (attempt.status === "guard") {
    return fail(
      "working_state_invalid",
      attempt.issues
        .map((issue) => `${issue.code}: ${issue.detail}`)
        .join("; "),
      {
        cause: "working_state_invalid",
        at: attempt.issues.map((issue) => issue.code),
      },
    );
  }
  const { seed } = attempt;

  const payload: CheckpointPayload = {
    id: identity.checkpointId,
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    sourceBasis: source.basis,
    artifactProvenance: reuse.reusable ? reuse.provenance : null,
    versions: {
      generatorVersion: CHECKPOINT_GENERATOR_VERSION,
      builderVersion: CHECKPOINT_BUILDER_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
    },
    modelSelection,
    sections: seed.sections as CheckpointPayload["sections"],
    seedText: seed.seedText,
    seedSha256: seed.seedSha256,
    sectionBytes: seed.sectionBytes,
    omissions: seed.omissions,
    generationPassCount: passCount,
    createdAt: input.createdAt,
  };
  log.info("checkpoint.generation.completed", {
    conversationId: identity.conversationId,
    operationId: identity.checkpointId,
    capturedThroughSeq: source.basis.capturedThroughSeq,
    seedBytes: payload.sectionBytes.total,
    seedSha256: payload.seedSha256,
    generationPassCount: passCount,
    envelopeReused: reuse.reusable,
  });
  return {
    ok: true,
    payload,
    ...(seed.handoffDecision ? { handoffDecision: seed.handoffDecision } : {}),
    ...telemetry(),
  };
}
