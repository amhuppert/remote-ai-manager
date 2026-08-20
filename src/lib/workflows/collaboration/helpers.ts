/**
 * Shared utilities for the asymmetric collaboration slice.
 *
 * These are pure or near-pure helpers that the orchestrator (`envelope.ts`)
 * and the phase files (`initial-draft.ts`, `cross-review.ts`,
 * `counter-proposal.ts`, `resolution.ts`) all consume. Lifting them here
 * keeps the phase files from reaching back into `envelope.ts` for utility
 * code; the orchestrator-state mutation entry points (`failRun`,
 * `persistArtifactsSnapshot`, `finalizeFinal`) stay in `envelope.ts`
 * because they depend on private orchestration glue.
 */

import { getErrorMessage } from "@/lib/shared/errors";
import type { CollaborationFailureCause } from "./failure-cause";
import type {
  CollaborationStepKey,
  CollaborationStepLedger,
} from "./step-ledger";
import { validateGeneratedArtifactFiles } from "./artifact-files";
import {
  DEFAULT_LANE_WRITE_CAPABILITY,
  type AgentCallRequest,
  type AgentCallResult,
  type LaneWriteCapability,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
} from "./envelope";
import type { BuiltCollaborationPrompt } from "./prompt-builders";
import {
  buildLaneSystemInstructions,
  prefixPromptWithTicketBlock,
} from "./session-context";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type {
  CollaborationAgent,
  CollaborationAgentArtifactPhase,
  CollaborationArtifact,
  CollaborationFlowAgent,
} from "./types";

export interface ArtifactTracker {
  /**
   * In-memory accumulator and the in-run source of truth: the negotiation
   * loop composes each round's prompt from these prior-round artifacts. The
   * sidecar file (`appendSink`) is the durability sink, not the in-run read
   * path, so the loop never round-trips through storage.
   */
  artifacts: CollaborationArtifact[];
  negotiationRoundsCompleted: number;
  /**
   * Durability sink invoked once per tracked artifact, in append order. The
   * production sink appends the artifact to the workflow's JSONL sidecar; the
   * push to `artifacts` happens regardless so an unconfigured sink (no-op)
   * still keeps the in-run accumulator correct.
   */
  appendSink?: (artifact: CollaborationArtifact) => Promise<void>;
}

export async function trackArtifact(
  tracker: ArtifactTracker,
  artifact: CollaborationArtifact,
): Promise<void> {
  tracker.artifacts.push(artifact);
  if (tracker.appendSink) {
    await tracker.appendSink(artifact);
  }
}

// ============================================================
// Structured-output parser.
// ============================================================

export type ParseSuccess<T> = { success: true; value: T };
export type ParseFailure = { success: false; error: string };
export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

export interface ParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<unknown>;
            message: string;
          }>;
        };
      };
}

/**
 * Orchestrator-owned bookkeeping injected onto a model-authored artifact after
 * parsing. The model is no longer asked to emit any of these — they are derived
 * deterministically from the phase the orchestrator is running:
 *   - envelope: `kind` (the phase), `agent`, optional `target_agent`, `round`
 *   - each generated artifact: `round` = envelope round, `agent` = envelope
 *     agent, `phase` = envelope kind
 */
export interface ArtifactInjection {
  kind: CollaborationAgentArtifactPhase;
  agent: CollaborationFlowAgent;
  round: number;
  target_agent?: CollaborationFlowAgent;
}

function formatSchemaIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }>,
): string {
  return issues
    .map(
      (issue) => `${(issue.path.join(".") || "$") as string}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * Parses a phase turn's structured output against the model-facing `content`
 * schema, injects the orchestrator-owned bookkeeping, then validates the
 * reconstructed full artifact against `full`.
 *
 * Splitting the two stages is what makes failures legible: a `schema_validation`
 * error is something the model got wrong about the content it authored (with a
 * named path, e.g. `artifacts: must include a generated artifact with id
 * "main"...`), whereas an `injection_invariant` error means the orchestrator
 * produced an inconsistent envelope — a programming error, not the model's
 * fault. The old single-schema parse collapsed both into an opaque
 * `$: Invalid input`.
 */
export function parseAndInjectArtifact<F>(
  flowAgent: CollaborationFlowAgent,
  result: AgentCallResult,
  args: {
    contentSchema: ParseSchema<unknown>;
    fullSchema: ParseSchema<F>;
    injection: ArtifactInjection;
  },
): ParseOutcome<F> {
  const { contentSchema, fullSchema, injection } = args;
  const artifactKind = injection.kind;
  if (result.outcome.kind !== "completed") {
    return {
      success: false,
      error: `${artifactKind} (${flowAgent}) did not complete (outcome=${result.outcome.kind})`,
    };
  }

  const content = contentSchema.safeParse(result.outcome.structuredOutput);
  if (!content.success) {
    return {
      success: false,
      error: `${artifactKind} (${flowAgent}) schema_validation: ${formatSchemaIssues(content.error.issues)}`,
    };
  }

  // content.data validated against an object schema above, so it is safe to read
  // its `artifacts` array. The orchestrator owns every envelope and per-artifact
  // bookkeeping field; inject them so persistence, the artifact-file validator,
  // the UI, and downstream prompt building all see the full artifact shape.
  const contentData = content.data as {
    artifacts?: ReadonlyArray<Record<string, unknown>>;
  } & Record<string, unknown>;
  const artifactRefs = {
    round: injection.round,
    agent: injection.agent,
    phase: injection.kind,
  };
  const injectedArtifacts = (contentData.artifacts ?? []).map((artifact) => ({
    ...artifact,
    ...artifactRefs,
  }));
  const merged = {
    ...injection,
    ...contentData,
    artifacts: injectedArtifacts,
  };

  const full = fullSchema.safeParse(merged);
  if (!full.success) {
    return {
      success: false,
      error: `${artifactKind} (${flowAgent}) injection_invariant: ${formatSchemaIssues(full.error.issues)}`,
    };
  }
  return { success: true, value: full.data };
}

// ============================================================
// AgentCall facade with lane scheduling and structured-output parse.
// ============================================================

export interface CallPrimitiveContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  flowAgent: CollaborationFlowAgent;
  backend: CollaborationAgent;
  prompt: BuiltCollaborationPrompt;
  imageRefs?: readonly ConversationImageRef[];
  /**
   * Defaults to `write_capable`. Use `read_only` for planning calls that
   * emit structured output without modifying the worktree, and
   * `artifact_only` for calls whose only writes are their lane-scoped
   * generated-artifact files (disjoint per agent/phase) — both let the lane
   * scheduler bypass the per-session write lock so multiple agents can run
   * in parallel.
   */
  writeCapability?: LaneWriteCapability;
}

export type CallPrimitiveOutcome =
  | { kind: "ok"; result: AgentCallResult }
  | {
      kind: "failed";
      errorSummary: string;
      /**
       * The backend classifier's own verdict, preserved rather than flattened
       * into `errorSummary`. It is what lets a failed run say whether the
       * provider was unavailable — the difference between offering the user a
       * resume and telling them to start over.
       */
      cause: CollaborationFailureCause;
    };

/**
 * The lane's governing instruction string: session context first, then the
 * profile block. Each part is self-delimited (the profile block carries its
 * own fences), so joining preserves every part byte-for-byte.
 */
function joinLaneInstructions(
  base: string | null,
  profileBlock: string | undefined,
): string | null {
  const parts: string[] = [];
  if (base !== null) parts.push(base);
  if (profileBlock !== undefined && profileBlock.trim().length > 0) {
    parts.push(profileBlock);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

export async function callPrimitive(
  ctx: CallPrimitiveContext,
): Promise<CallPrimitiveOutcome> {
  const { input, deps, backend, prompt, imageRefs } = ctx;
  const writeCapability = ctx.writeCapability ?? DEFAULT_LANE_WRITE_CAPABILITY;
  // Lane identity is the flow agent, not the backend: both agents may run the
  // same backend, and their lanes must stay distinct continuity records.
  const laneRef = { workflowId: input.workflowId, laneId: ctx.flowAgent };

  // The one seam that decorates a collaboration request with the run's captured
  // premises, so every phase and both lanes get identical context regardless of
  // which backend runs them. Each context keeps the channel matching its
  // authority: the charter governs the call, the ticket view is task context on
  // the work prompt. A snapshot with neither leaves the request untouched.
  //
  // The lane's agent-profile layer rides the same channel: the STORED rendered
  // block is appended verbatim (never re-rendered), so a restart replays the
  // exact bytes the run was staffed with. The Standard Agent default renders
  // an empty block and appends nothing.
  const profileBlock =
    input.agents?.[ctx.flowAgent]?.profileSnapshot?.renderedInstructionBlock;
  const systemInstructions = joinLaneInstructions(
    buildLaneSystemInstructions(input.sessionContext),
    profileBlock,
  );
  const governance =
    systemInstructions !== null ? { systemInstructions } : ({} as const);
  const composedPrompt = prefixPromptWithTicketBlock(
    input.sessionContext,
    prompt.prompt,
  );

  const request: AgentCallRequest =
    backend === "claude"
      ? {
          kind: "conversation_turn",
          backend: "claude",
          prompt: composedPrompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
          ...governance,
          ...(imageRefs?.length ? { imageRefs: [...imageRefs] } : {}),
        }
      : {
          kind: "task_run",
          backend: "codex",
          prompt: composedPrompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
          ...governance,
          ...(imageRefs?.length ? { imageRefs: [...imageRefs] } : {}),
        };

  // Lane scheduling is owned by the WorkflowAgentCaller behind
  // `deps.callAgent` — the single acquisition point (D16). No scheduling here.
  let result: AgentCallResult;
  try {
    result = await deps.callAgent(request);
  } catch (err) {
    return {
      kind: "failed",
      errorSummary: getErrorMessage(err),
      cause: { kind: "unhandled" },
    };
  }

  if (result.outcome.kind === "failed") {
    const error = result.outcome.error;
    return {
      kind: "failed",
      errorSummary: `${error.failureKind}: ${error.message}`,
      cause: {
        kind: "agent_call",
        failureKind: error.failureKind,
        ...(error.retryable !== undefined
          ? { retryable: error.retryable }
          : {}),
        ...(error.retryAfterHint !== undefined
          ? { retryAfterHint: error.retryAfterHint }
          : {}),
      },
    };
  }
  if (result.outcome.kind === "paused") {
    return {
      kind: "failed",
      errorSummary: `unexpected pause from lane (pauseKind=${result.outcome.pauseKind}, resumeToken=${result.outcome.resumeToken})`,
      cause: { kind: "unhandled" },
    };
  }

  await deps.laneService.recordOutcome(laneRef, {
    backend,
    ...(result.backendRef && result.backendRef.backend === backend
      ? { ref: result.backendRef.ref }
      : {}),
  });

  return { kind: "ok", result };
}

// ============================================================
// One collaboration step: replay it, or produce it.
// ============================================================

export interface ProduceCollaborationStepContext<F> {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  /** The prior attempt's recorded outputs, or null for a run with no history. */
  ledger: CollaborationStepLedger | null;
  /** What identifies this step in the log. A key already recorded is a step
   *  that already ran, so it is replayed instead of dispatched again. */
  key: CollaborationStepKey;
  flowAgent: CollaborationFlowAgent;
  backend: CollaborationAgent;
  prompt: BuiltCollaborationPrompt;
  contentSchema: ParseSchema<unknown>;
  fullSchema: ParseSchema<F>;
  injection: ArtifactInjection;
  imageRefs?: readonly ConversationImageRef[];
  writeCapability?: LaneWriteCapability;
}

export type ProduceCollaborationStepOutcome<F> =
  /** Recorded by an earlier attempt. Already on disk and already in the
   *  tracker, so the caller must NOT commit it again. */
  | { kind: "replayed"; artifact: F }
  | { kind: "produced"; artifact: F }
  | { kind: "failed"; errorSummary: string; cause: CollaborationFailureCause };

/**
 * Runs one collaboration step end to end, or replays it from the ledger.
 *
 * Deliberately does NOT commit the artifact or terminalize the run: the
 * parallel initial-draft phase must gather both peers before either failure is
 * final, and committing inside two concurrent calls would make the on-disk
 * order non-deterministic. The caller owns `trackArtifact` and `failRun`.
 */
export async function produceCollaborationStep<F>(
  ctx: ProduceCollaborationStepContext<F>,
): Promise<ProduceCollaborationStepOutcome<F>> {
  const replayed = ctx.ledger?.replay(ctx.key) ?? null;
  if (replayed !== null) {
    return { kind: "replayed", artifact: replayed as F };
  }

  const call = await callPrimitive({
    input: ctx.input,
    deps: ctx.deps,
    flowAgent: ctx.flowAgent,
    backend: ctx.backend,
    prompt: ctx.prompt,
    ...(ctx.imageRefs !== undefined ? { imageRefs: ctx.imageRefs } : {}),
    ...(ctx.writeCapability !== undefined
      ? { writeCapability: ctx.writeCapability }
      : {}),
  });
  if (call.kind === "failed") {
    return {
      kind: "failed",
      errorSummary: call.errorSummary,
      cause: call.cause,
    };
  }

  const parsed = parseAndInjectArtifact(ctx.flowAgent, call.result, {
    contentSchema: ctx.contentSchema,
    fullSchema: ctx.fullSchema,
    injection: ctx.injection,
  });
  if (!parsed.success) {
    return {
      kind: "failed",
      errorSummary: parsed.error,
      cause: { kind: "structured_output" },
    };
  }

  const validation = await validateGeneratedArtifactFiles({
    worktreePath: ctx.input.worktreePath,
    workflowId: ctx.input.workflowId,
    artifact: parsed.value as Parameters<
      typeof validateGeneratedArtifactFiles
    >[0]["artifact"],
  });
  if (!validation.success) {
    return {
      kind: "failed",
      errorSummary: `${ctx.injection.kind} (${ctx.flowAgent}) artifact_files: ${validation.error}`,
      cause: { kind: "artifact_files" },
    };
  }

  return { kind: "produced", artifact: parsed.value };
}
