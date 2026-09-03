import { z } from "zod";
import { conflictEntrySchema } from "../jobs/schemas";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";
import { assertNever } from "../shared/assert-never";
import { createLogger } from "../logging";
import { executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import { executeFreshTaskRun as defaultExecuteFreshTaskRun } from "@/lib/workflows/conversation/execute-fresh-task-run";
import type {
  AgentTurnDispatch,
  ExecuteFreshTaskRunInput,
} from "@/lib/workflows/conversation/execute-fresh-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { buildIncomingChangesSection as defaultBuildIncomingChangesSection } from "@/lib/merge-intents/incoming-changes";
import type { IncomingChangesParams } from "@/lib/merge-intents/incoming-changes";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
import {
  isAbortFailure,
  type AgentFailureClassification,
} from "@/lib/agent-backends/errors";
import { containsConflictMarkers } from "@/lib/git/conflict-markers";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conflict-resolution");

/**
 * Wall-clock bound on a single resolver or analyzer turn. The turn holds the
 * merge — and with it the session's git lock and a worktree left mid-merge —
 * for as long as it runs, so an agent that never returns must be cut off
 * rather than waited on. Generous enough that a legitimately large conflict
 * set finishes inside it.
 */
export const DEFAULT_RESOLUTION_TIMEOUT_MS = 900_000;

// Anthropic tool input_schema requires `type: "object"` at the root, so the
// array of entries is wrapped under a `conflicts` property.
const CONFLICT_ENTRIES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["conflicts"],
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "description", "resolution", "rationale"],
        properties: {
          file: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          resolution: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

// ============================================================
// Dependency Injection
// ============================================================

export interface ConflictResolutionDeps {
  /**
   * Named entrypoint that routes a single `task_run` turn through the
   * conversation actor for the conversation identified by
   * `(projectPath, sessionName, conversationId)`. The conflict resolver passes
   * the conflict JSON schema as `outputFormat` so the conversation actor's
   * structured-output gate validates the result against the schema before
   * surfacing it to the caller.
   */
  executeWorkflowTaskRun?(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
  /** One-shot entrypoint for `fresh-run` dispatch (graph joins — see
   *  {@link AgentTurnDispatch}); same result contract, no conversation. */
  executeFreshTaskRun?(input: ExecuteFreshTaskRunInput): Promise<TaskRunResult>;
  /**
   * Describes the commits arriving from the target branch (the other side of
   * the conflicts), annotated with recorded merge intents. Best-effort: null
   * means no section is appended.
   */
  buildIncomingChangesSection?(
    params: IncomingChangesParams,
  ): Promise<string | null>;
  /**
   * Ground-truth check for the post-resolution verification: files git still
   * reports as unmerged in the worktree. Defaults to the real
   * `git diff --diff-filter=U`.
   */
  listUnmergedFiles?(worktreePath: string): Promise<string[]>;
  /**
   * Tracked files whose change against HEAD carries conflict markers,
   * regardless of whether anybody named them. Defaults to the git layer's
   * scan — the same reading the commit guard refuses on.
   */
  listTrackedMarkerFiles?(worktreePath: string): Promise<string[]>;
  /**
   * Reads a worktree file for the post-resolution marker scan. Null when the
   * file does not exist (or cannot be read) — such files are skipped.
   */
  readWorktreeFile?(
    worktreePath: string,
    relativePath: string,
  ): Promise<string | null>;
}

const defaultDeps: ConflictResolutionDeps = {};

// ============================================================
// Public Types
// ============================================================

/**
 * Three-way outcome. `unresolved` and `infrastructure` are kept apart because
 * they demand opposite responses: an unresolved conflict is file content a
 * human or a re-dispatched agent must decide, while an infrastructure failure
 * means the resolver never read the conflict at all — retrying it against the
 * same wall (or blaming the files it never opened) is wrong on both counts.
 */
export type ConflictResolutionResult =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | {
      /** The resolver ran against the conflict and it is still unresolved:
       *  ground-truth verification failed, or verification could not run. */
      status: "unresolved";
      error: string;
      partialConflicts?: ConflictEntry[];
    }
  | {
      /** The resolver never (or only partially) ran: backend error, quota,
       *  abort, timeout, structured-output failure. */
      status: "infrastructure";
      failure: AgentFailureClassification;
    };

export type ConflictAnalysisResult =
  | { status: "analyzed"; conflicts: ConflictEntry[] }
  | { status: "infrastructure"; failure: AgentFailureClassification };

export interface ResolveConflictsParams {
  /** How the agent turn executes; absent means `conversation`. Under
   *  `fresh-run` the conversationId is an identity source only. */
  agentTurnDispatch?: AgentTurnDispatch;
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId?: string;
  decisions?: ConflictDecisionInput[];
  /** Intent notes about the changes on each side of the merge, written by the
   *  agents that implemented them; injected into the prompt so the resolver
   *  understands intent instead of inferring it from conflict markers alone. */
  resolutionContext?: string;
  /** Branch being merged in; enables the incoming-changes lookup that
   *  describes the other side of the conflicts to the resolver. */
  targetBranch?: string;
  /** Files the merge reported as conflicted. Scanned for leftover conflict
   *  markers after the agent claims resolution — a resolution that stages a
   *  file with markers clears git's unmerged state, so the unmerged-paths
   *  check alone cannot catch it. */
  conflictFiles?: string[];
  /** Overrides {@link DEFAULT_RESOLUTION_TIMEOUT_MS} for this turn. */
  resolutionTimeoutMs?: number;
  /** Cancels the resolver turn when the caller's run is stopped, so the agent
   *  stops editing a worktree nothing is waiting on. */
  signal?: AbortSignal;
}

export interface AnalyzeConflictsParams {
  /** See {@link ResolveConflictsParams.agentTurnDispatch}. */
  agentTurnDispatch?: AgentTurnDispatch;
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId?: string;
  /** See {@link ResolveConflictsParams.resolutionContext}. */
  resolutionContext?: string;
  /** See {@link ResolveConflictsParams.targetBranch}. */
  targetBranch?: string;
  /** See {@link ResolveConflictsParams.resolutionTimeoutMs}. */
  resolutionTimeoutMs?: number;
  /** See {@link ResolveConflictsParams.signal}. */
  signal?: AbortSignal;
}

// ============================================================
// System Prompt
// ============================================================

const CONFLICT_RESOLUTION_INSTRUCTIONS = `You are a merge conflict resolution specialist. Your task is to resolve all git merge conflicts in this worktree.

Follow these steps precisely:

1. Run \`git diff --name-only --diff-filter=U\` to find all conflicted files.
2. Read each conflicted file and analyze the conflict markers (<<<<<<< HEAD, =======, >>>>>>> markers).
3. For each file, determine the best resolution by understanding the intent of both sides.
4. Edit each file to remove all conflict markers and produce the correct merged content.
5. Stage each resolved file with \`git add <file>\`.
6. After resolving ALL conflicts, return your analysis as the structured output the response schema requires (one entry per conflicted file).

IMPORTANT:
- Resolve ALL conflicted files before producing the structured output.
- Every conflict marker must be removed — no <<<<<<< or ======= or >>>>>>> markers should remain.
- Stage every resolved file with git add.
- Work ONLY in the current working directory — never cd into another worktree or repository.
- NEVER initiate a merge yourself: do not run git merge, git pull, git rebase, or git cherry-pick. The orchestrator has already started the merge you are resolving.
- NEVER run git commit. Leave the merge in progress with every resolved file staged; the orchestrator commits it.
- If git reports no conflicted files and no merge is in progress, there is nothing to resolve: return an empty conflicts array as the structured output. Do NOT infer an intended merge from history and start it.`;

const CONFLICT_ANALYSIS_INSTRUCTIONS = `You are a merge conflict analysis specialist. Your task is to analyze all git merge conflicts in this worktree and describe them, WITHOUT resolving them.

Follow these steps precisely:

1. Run \`git diff --name-only --diff-filter=U\` to find all conflicted files.
2. Read each conflicted file and analyze the conflict markers (<<<<<<< HEAD, =======, >>>>>>> markers).
3. For each file, understand the intent of both sides and propose how the conflict should be resolved.
4. Return your analysis as the structured output the response schema requires (one entry per conflicted file).

IMPORTANT:
- DO NOT edit any files. DO NOT remove conflict markers. DO NOT run git add. This is analysis only.
- Analyze ALL conflicted files before producing the structured output.
- Work ONLY in the current working directory — never cd into another worktree or repository.
- NEVER run git merge, git pull, git rebase, or any other command that mutates the worktree.
- If git reports no conflicted files, there is nothing to analyze: return an empty conflicts array as the structured output.`;

// ============================================================
// Resolution Context Prompt Builder
// ============================================================

function buildResolutionContextSection(resolutionContext: string): string {
  return [
    "",
    "## Context about the changes being merged",
    "",
    "These notes were written by the agents who implemented the changes on each side of this merge. Use them to understand the intent behind each side when deciding how to resolve every conflict:",
    "",
    resolutionContext,
  ].join("\n");
}

/**
 * Fetch the incoming-changes section (the other side of the conflicts) and
 * render it as a prompt suffix. Empty string when there is no target branch
 * or nothing to describe.
 */
async function lookupIncomingChangesSection(
  params: {
    projectPath: string;
    worktreePath: string;
    targetBranch: string | undefined;
  },
  deps: ConflictResolutionDeps,
): Promise<string> {
  if (!params.targetBranch) return "";
  const buildIncomingChangesSection =
    deps.buildIncomingChangesSection ?? defaultBuildIncomingChangesSection;
  const section = await buildIncomingChangesSection({
    projectPath: params.projectPath,
    worktreePath: params.worktreePath,
    targetBranch: params.targetBranch,
  });
  if (!section) return "";
  return `\n\n## Incoming changes on the other side of the merge\n\n${section}`;
}

// ============================================================
// Decision Prompt Builder
// ============================================================

function buildDecisionsPrompt(decisions: ConflictDecisionInput[]): string {
  const lines: string[] = [
    "\nYou have per-file instructions from a human reviewer:",
    "",
  ];

  for (const d of decisions) {
    switch (d.decision) {
      case "approved":
        lines.push(
          `- **${d.file}**: APPROVED — resolve this file freely using your best judgment.`,
        );
        break;
      case "rejected":
        lines.push(
          `- **${d.file}**: REJECTED — the previous resolution was not acceptable.${d.feedback ? ` User feedback: "${d.feedback}"` : ""} Incorporate the user's guidance when resolving this file.`,
        );
        break;
      case "pending":
        lines.push(
          `- **${d.file}**: PENDING — no decision from the user yet. Resolve this file with extra care, preferring the safest merge strategy.`,
        );
        break;
      default:
        assertNever(d.decision);
    }
  }

  return lines.join("\n");
}

// ============================================================
// Conflict Entry Parsing
// ============================================================

// Accepts either the wrapped object `{ conflicts: [...] }` produced by the
// Anthropic tool-call path, or the bare array a model may emit in free text.
const conflictEntriesPayloadSchema = z.union([
  z.object({ conflicts: z.array(conflictEntrySchema) }),
  z.array(conflictEntrySchema),
]);

function unwrapEntries(
  parsed: z.infer<typeof conflictEntriesPayloadSchema>,
): ConflictEntry[] {
  return Array.isArray(parsed) ? parsed : parsed.conflicts;
}

/**
 * Parse conflict entries from a task-run result via the shared
 * structured-output module (extraction precedence native → raw JSON → last
 * fenced block, first schema-passing candidate wins). An invalid native
 * candidate does not hard-fail: the chain falls through to a schema-valid raw
 * or fenced text candidate in the same turn (Phase 3 review F5, approved in
 * the 2026-07-13 addendum to the Phase 1 slice designs).
 */
export function parseConflictEntries(
  text: string | null,
  structuredOutput: unknown,
): { conflicts: ConflictEntry[] } | { error: string } {
  const validated = validateStructuredOutput(conflictEntriesPayloadSchema, {
    ...(structuredOutput != null ? { native: structuredOutput } : {}),
    text,
  });
  if (!validated.ok) {
    return { error: validated.error };
  }
  logger.debug("conflict-resolution.parsed", { source: validated.source });
  return { conflicts: unwrapEntries(validated.value) };
}

// ============================================================
// Post-resolution ground-truth verification
// ============================================================

async function defaultListUnmergedFiles(
  worktreePath: string,
): Promise<string[]> {
  const { listUnmergedFiles } = await import("@/lib/git/worktree");
  return listUnmergedFiles(worktreePath);
}

async function defaultListTrackedMarkerFiles(
  worktreePath: string,
): Promise<string[]> {
  const { scanConflictArtifacts } = await import("@/lib/git/conflict-markers");
  return (await scanConflictArtifacts(worktreePath)).markerFiles;
}

async function defaultReadWorktreeFile(
  worktreePath: string,
  relativePath: string,
): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    return await readFile(path.join(worktreePath, relativePath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Verify a claimed resolution against git ground truth before the caller
 * commits it: no unmerged index entries may remain, and no marker may survive
 * in the files the merge reported as conflicted, the files the agent claims to
 * have resolved, or any tracked file the turn changed. The agent's "resolved"
 * signal is never trusted on its own — a mis-dispatched or sloppy agent turn
 * otherwise gets its markers committed verbatim by the next machine state —
 * and the third reading is what makes the check independent of the entry path:
 * a re-entry that lost the conflict list, or an agent that stages a
 * marker-bearing file it never mentions, is caught by git's own scan.
 */
async function verifyResolutionGroundTruth(
  resolution: { status: "resolved"; conflicts: ConflictEntry[] },
  params: { worktreePath: string; conflictFiles: string[] },
  deps: ConflictResolutionDeps,
): Promise<ConflictResolutionResult> {
  const listUnmergedFiles = deps.listUnmergedFiles ?? defaultListUnmergedFiles;
  const listTrackedMarkerFiles =
    deps.listTrackedMarkerFiles ?? defaultListTrackedMarkerFiles;
  const readWorktreeFile = deps.readWorktreeFile ?? defaultReadWorktreeFile;
  const { worktreePath } = params;

  let unmerged: string[];
  let trackedMarkerFiles: string[];
  try {
    unmerged = await listUnmergedFiles(worktreePath);
    trackedMarkerFiles = await listTrackedMarkerFiles(worktreePath);
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    logger.error("conflict-resolution.ground_truth_check_error", {
      worktreePath,
      error: errorMsg,
    });
    return {
      status: "unresolved",
      error: `Could not verify conflict resolution in ${worktreePath}: ${errorMsg}`,
      partialConflicts: resolution.conflicts,
    };
  }

  if (unmerged.length > 0) {
    logger.error("conflict-resolution.ground_truth_unmerged", {
      worktreePath,
      unmerged,
    });
    return {
      status: "unresolved",
      error: `Conflict resolution reported success but ${unmerged.length} file(s) remain unresolved in ${worktreePath}: ${unmerged.join(", ")}`,
      partialConflicts: resolution.conflicts,
    };
  }

  // Already confirmed against the marker regex by the git-layer scan, so the
  // named files are the only ones this re-reads.
  const filesToScan = [
    ...new Set([
      ...params.conflictFiles,
      ...resolution.conflicts.map((entry) => entry.file),
    ]),
  ].filter((file) => !trackedMarkerFiles.includes(file));
  const markerFiles: string[] = [...trackedMarkerFiles];
  for (const file of filesToScan) {
    const content = await readWorktreeFile(worktreePath, file);
    if (content !== null && containsConflictMarkers(content)) {
      markerFiles.push(file);
    }
  }

  if (markerFiles.length > 0) {
    logger.error("conflict-resolution.ground_truth_markers", {
      worktreePath,
      markerFiles,
    });
    return {
      status: "unresolved",
      error: `Conflict resolution left conflict markers in: ${markerFiles.join(", ")}`,
      partialConflicts: resolution.conflicts,
    };
  }

  logger.info("conflict-resolution.ground_truth_verified", {
    worktreePath,
    namedFiles: filesToScan.length,
  });
  return resolution;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Create a conflict resolver with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createConflictResolver(
  deps: ConflictResolutionDeps = defaultDeps,
) {
  return {
    resolveConflicts: (
      params: ResolveConflictsParams,
    ): Promise<ConflictResolutionResult> => resolveConflictsImpl(params, deps),
    analyzeConflicts: (
      params: AnalyzeConflictsParams,
    ): Promise<ConflictAnalysisResult> => analyzeConflictsImpl(params, deps),
  };
}

/**
 * Resolve merge conflicts via the conversation actor.
 *
 * Routes a single `task_run` turn through `executeWorkflowTaskRun` so the call
 * participates in the conversation lifecycle (lock, transcript, broadcast) and
 * the structured-output gate validates the response against
 * `CONFLICT_ENTRIES_OUTPUT_SCHEMA`.
 */
/**
 * Route one conflict agent turn by dispatch mode with an identical result
 * contract, so both mapping pipelines stay dispatch-agnostic.
 */
async function dispatchConflictTurn(input: {
  dispatch: AgentTurnDispatch;
  deps: ConflictResolutionDeps;
  projectPath: string;
  sessionName: string;
  conversationId?: string;
  worktreePath: string;
  prompt: string;
  systemInstructions: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<TaskRunResult> {
  const outputFormat = {
    type: "json_schema" as const,
    schema: CONFLICT_ENTRIES_OUTPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
  };
  if (input.dispatch === "fresh-run") {
    const executeFreshTaskRun =
      input.deps.executeFreshTaskRun ?? defaultExecuteFreshTaskRun;
    return executeFreshTaskRun({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      ...(input.conversationId !== undefined
        ? { identityConversationId: input.conversationId }
        : {}),
      worktreePath: input.worktreePath,
      prompt: input.prompt,
      systemInstructions: input.systemInstructions,
      outputFormat,
      timeoutMs: input.timeoutMs,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  if (input.conversationId === undefined) {
    throw new Error(
      "Conversation dispatch requires a conversationId; callers without one must use the fresh-run dispatch",
    );
  }
  const executeWorkflowTaskRun =
    input.deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  return executeWorkflowTaskRun({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    worktreePath: input.worktreePath,
    kind: "task_run",
    prompt: input.prompt,
    systemInstructions: input.systemInstructions,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    outputFormat,
    origin: { source: "workflow" },
  });
}

export async function resolveConflicts(
  params: ResolveConflictsParams,
): Promise<ConflictResolutionResult> {
  return resolveConflictsImpl(params, defaultDeps);
}

async function resolveConflictsImpl(
  params: ResolveConflictsParams,
  deps: ConflictResolutionDeps,
): Promise<ConflictResolutionResult> {
  const {
    worktreePath,
    decisions,
    projectPath,
    sessionName,
    conversationId,
    resolutionContext,
    targetBranch,
    conflictFiles,
  } = params;
  const timeoutMs = params.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS;

  logger.info("conflict-resolution.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    resolutionContextLength: resolutionContext?.length ?? 0,
    targetBranch: targetBranch ?? null,
    timeoutMs,
  });

  let prompt =
    "Resolve all merge conflicts in this worktree. Follow the instructions in your system prompt precisely.";

  if (resolutionContext) {
    prompt += buildResolutionContextSection(resolutionContext);
  }

  prompt += await lookupIncomingChangesSection(
    { projectPath, worktreePath, targetBranch },
    deps,
  );

  if (decisions && decisions.length > 0) {
    prompt += buildDecisionsPrompt(decisions);
  }

  try {
    const result = await dispatchConflictTurn({
      dispatch: params.agentTurnDispatch ?? "conversation",
      deps,
      projectPath,
      sessionName,
      conversationId,
      worktreePath,
      prompt,
      systemInstructions: CONFLICT_RESOLUTION_INSTRUCTIONS,
      timeoutMs,
      signal: params.signal,
    });

    const resolution = mapTaskRunResultToResolution(result, worktreePath);
    if (resolution.status !== "resolved") return resolution;
    return await verifyResolutionGroundTruth(
      resolution,
      { worktreePath, conflictFiles: conflictFiles ?? [] },
      deps,
    );
  } catch (err) {
    const failure = classifyThrownDispatchFailure(err);
    logger.error("conflict-resolution.runner_error", {
      worktreePath,
      error: failure.message,
      failureKind: failure.kind,
    });
    return { status: "infrastructure", failure };
  }
}

/**
 * Fallback classification for a failed turn the conversation layer did not
 * classify. `aborted` is a turn fact rather than message text, so it decides
 * before any message-shape reading; everything else is an unrecognized
 * backend failure, which is never retried on the strength of a guess.
 */
function classifyTaskRunError(
  result: Extract<TaskRunResult, { kind: "error" }>,
): AgentFailureClassification {
  if (result.failure) return applyResolutionRetryPolicy(result.failure);
  return {
    kind: result.aborted ? "aborted" : "backend_error",
    message: result.error,
    retryable: false,
  };
}

/**
 * Retryability of a resolver turn in the merge context, which differs from the
 * backend's general answer for one kind.
 *
 * A backend classifier answers for an arbitrary conversation turn, where a
 * timeout leaves a turn of unknown progress attached to a live conversation
 * and re-dispatching it may duplicate whatever it did. The resolver's turn is
 * different on both counts: the caller cut it off at a bound it chose, and the
 * merge retry starts from an aborted merge and a re-created conflict, so a
 * second attempt repeats nothing. A slow or stuck turn is precisely the
 * transient failure the join's single clean retry exists for; every other kind
 * keeps the backend's verdict.
 */
function applyResolutionRetryPolicy(
  failure: AgentFailureClassification,
): AgentFailureClassification {
  if (failure.kind !== "timeout" || failure.retryable) return failure;
  return { ...failure, retryable: true };
}

function classifyThrownDispatchFailure(
  err: unknown,
): AgentFailureClassification {
  return {
    kind: isAbortFailure(err) ? "aborted" : "backend_error",
    message: getErrorMessage(err),
    retryable: false,
  };
}

/**
 * A turn that came back but carried no schema-valid conflict payload. The
 * agent may still have edited the files correctly, so this is a retryable
 * infrastructure failure rather than a verdict about the conflict.
 */
function classifyParseFailure(error: string): AgentFailureClassification {
  return { kind: "schema_validation", message: error, retryable: true };
}

function mapTaskRunResultToResolution(
  result: TaskRunResult,
  worktreePath: string,
): ConflictResolutionResult {
  if (result.kind === "error") {
    const failure = classifyTaskRunError(result);
    logger.error("conflict-resolution.task_error", {
      worktreePath,
      error: result.error,
      aborted: result.aborted,
      failureKind: failure.kind,
      retryable: failure.retryable,
    });
    return { status: "infrastructure", failure };
  }

  const { text, structuredOutput } = extractTextAndStructured(result);
  const parseResult = parseConflictEntries(text, structuredOutput);
  if ("error" in parseResult) {
    logger.warn("conflict-resolution.parse_error", {
      worktreePath,
      error: parseResult.error,
    });
    return {
      status: "infrastructure",
      failure: classifyParseFailure(parseResult.error),
    };
  }

  logger.info("conflict-resolution.resolved", {
    worktreePath,
    conflictCount: parseResult.conflicts.length,
  });
  return { status: "resolved", conflicts: parseResult.conflicts };
}

function mapTaskRunResultToAnalysis(
  result: TaskRunResult,
  worktreePath: string,
): ConflictAnalysisResult {
  if (result.kind === "error") {
    const failure = classifyTaskRunError(result);
    logger.error("conflict-analysis.task_error", {
      worktreePath,
      error: result.error,
      aborted: result.aborted,
      failureKind: failure.kind,
      retryable: failure.retryable,
    });
    return { status: "infrastructure", failure };
  }

  const { text, structuredOutput } = extractTextAndStructured(result);
  const parseResult = parseConflictEntries(text, structuredOutput);
  if ("error" in parseResult) {
    logger.warn("conflict-analysis.parse_error", {
      worktreePath,
      error: parseResult.error,
    });
    return {
      status: "infrastructure",
      failure: classifyParseFailure(parseResult.error),
    };
  }

  logger.info("conflict-analysis.analyzed", {
    worktreePath,
    conflictCount: parseResult.conflicts.length,
  });
  return { status: "analyzed", conflicts: parseResult.conflicts };
}

function extractTextAndStructured(result: TaskRunResult): {
  text: string | null;
  structuredOutput: unknown;
} {
  if (result.kind === "structured") {
    return { text: null, structuredOutput: result.structuredOutput };
  }
  if (result.kind === "text") {
    return { text: result.text, structuredOutput: undefined };
  }
  return { text: null, structuredOutput: undefined };
}

// ============================================================
// Analyze Conflicts (analysis-only, no file edits)
// ============================================================

/**
 * Analyze merge conflicts without resolving them via the conversation actor.
 * Produces structured ConflictEntry[] describing each conflict and a proposed
 * resolution, but does NOT edit files or remove conflict markers.
 */
export async function analyzeConflicts(
  params: AnalyzeConflictsParams,
): Promise<ConflictAnalysisResult> {
  return analyzeConflictsImpl(params, defaultDeps);
}

async function analyzeConflictsImpl(
  params: AnalyzeConflictsParams,
  deps: ConflictResolutionDeps,
): Promise<ConflictAnalysisResult> {
  const {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    resolutionContext,
    targetBranch,
  } = params;
  const timeoutMs = params.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS;

  logger.info("conflict-analysis.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    resolutionContextLength: resolutionContext?.length ?? 0,
    targetBranch: targetBranch ?? null,
    timeoutMs,
  });

  let prompt =
    "Analyze all merge conflicts in this worktree. Follow the instructions in your system prompt precisely. Do NOT edit any files.";

  if (resolutionContext) {
    prompt += buildResolutionContextSection(resolutionContext);
  }

  prompt += await lookupIncomingChangesSection(
    { projectPath, worktreePath, targetBranch },
    deps,
  );

  try {
    const result = await dispatchConflictTurn({
      dispatch: params.agentTurnDispatch ?? "conversation",
      deps,
      projectPath,
      sessionName,
      conversationId,
      worktreePath,
      prompt,
      systemInstructions: CONFLICT_ANALYSIS_INSTRUCTIONS,
      timeoutMs,
      signal: params.signal,
    });

    return mapTaskRunResultToAnalysis(result, worktreePath);
  } catch (err) {
    const failure = classifyThrownDispatchFailure(err);
    logger.error("conflict-analysis.runner_error", {
      worktreePath,
      error: failure.message,
      failureKind: failure.kind,
    });
    return { status: "infrastructure", failure };
  }
}
