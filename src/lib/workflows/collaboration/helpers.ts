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
import type {
  AgentCallRequest,
  AgentCallResult,
  LaneWriteCapability,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
} from "./envelope";
import type { BuiltCollaborationPrompt } from "./prompt-builders";
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
  | { kind: "failed"; errorSummary: string };

export async function callPrimitive(
  ctx: CallPrimitiveContext,
): Promise<CallPrimitiveOutcome> {
  const { input, deps, backend, prompt } = ctx;
  const writeCapability = ctx.writeCapability ?? "write_capable";
  const laneRef = { workflowId: input.workflowId, laneId: backend };
  const request: AgentCallRequest =
    backend === "claude"
      ? {
          kind: "conversation_turn",
          backend: "claude",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        }
      : {
          kind: "task_run",
          backend: "codex",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        };

  let result: AgentCallResult;
  try {
    result = await deps.laneScheduler.schedule(
      {
        sessionKey: input.sessionKey,
        writeCapability,
        workflowId: input.workflowId,
        laneId: backend,
      },
      () => deps.callAgent(request),
    );
  } catch (err) {
    return { kind: "failed", errorSummary: getErrorMessage(err) };
  }

  if (result.outcome.kind === "failed") {
    return {
      kind: "failed",
      errorSummary: `${result.outcome.error.failureKind}: ${result.outcome.error.message}`,
    };
  }
  if (result.outcome.kind === "paused") {
    return {
      kind: "failed",
      errorSummary: `unexpected pause from lane (pauseKind=${result.outcome.pauseKind}, resumeToken=${result.outcome.resumeToken})`,
    };
  }

  await deps.laneService.recordOutcome(
    laneRef,
    backend === "claude"
      ? {
          backend: "claude",
          ...(result.backendRef && result.backendRef.backend === "claude"
            ? { conversationId: result.backendRef.sessionId }
            : {}),
        }
      : {
          backend: "codex",
          ...(result.backendRef && result.backendRef.backend === "codex"
            ? { threadId: result.backendRef.threadId }
            : {}),
        },
  );

  return { kind: "ok", result };
}
