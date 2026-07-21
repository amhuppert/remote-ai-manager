import { z } from "zod";
import { conflictEntrySchema } from "../jobs/schemas";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";
import { assertNever } from "../shared/assert-never";
import { createLogger } from "../logging";
import { executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { buildIncomingChangesSection as defaultBuildIncomingChangesSection } from "@/lib/merge-intents/incoming-changes";
import type { IncomingChangesParams } from "@/lib/merge-intents/incoming-changes";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conflict-resolution");

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

export type ConflictResolutionResult =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | { status: "failed"; error: string; partialConflicts?: ConflictEntry[] };

export type ConflictAnalysisResult =
  | { status: "analyzed"; conflicts: ConflictEntry[] }
  | { status: "failed"; error: string };

export interface ResolveConflictsParams {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
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
}

export interface AnalyzeConflictsParams {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
  /** See {@link ResolveConflictsParams.resolutionContext}. */
  resolutionContext?: string;
  /** See {@link ResolveConflictsParams.targetBranch}. */
  targetBranch?: string;
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

/**
 * Whether text contains git conflict begin/end markers (`<<<<<<< `,
 * `>>>>>>> `, or the diff3 `||||||| ` base marker) at line start. The bare
 * `=======` separator is deliberately NOT matched — it appears standalone in
 * legitimate content (markdown setext headings, ini separators) and never
 * without a begin/end marker in a real conflict.
 */
export function containsConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7}|\|{7}) /m.test(content);
}

async function defaultListUnmergedFiles(
  worktreePath: string,
): Promise<string[]> {
  const { listUnmergedFiles } = await import("@/lib/git/worktree");
  return listUnmergedFiles(worktreePath);
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
 * commits it: no unmerged index entries may remain, and neither the files the
 * merge reported as conflicted nor the files the agent claims to have
 * resolved may still contain conflict markers. The agent's "resolved" signal
 * is never trusted on its own — a mis-dispatched or sloppy agent turn
 * otherwise gets its markers committed verbatim by the next machine state.
 */
async function verifyResolutionGroundTruth(
  resolution: { status: "resolved"; conflicts: ConflictEntry[] },
  params: { worktreePath: string; conflictFiles: string[] },
  deps: ConflictResolutionDeps,
): Promise<ConflictResolutionResult> {
  const listUnmergedFiles = deps.listUnmergedFiles ?? defaultListUnmergedFiles;
  const readWorktreeFile = deps.readWorktreeFile ?? defaultReadWorktreeFile;
  const { worktreePath } = params;

  let unmerged: string[];
  try {
    unmerged = await listUnmergedFiles(worktreePath);
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    logger.error("conflict-resolution.ground_truth_check_error", {
      worktreePath,
      error: errorMsg,
    });
    return {
      status: "failed",
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
      status: "failed",
      error: `Conflict resolution reported success but ${unmerged.length} file(s) remain unresolved in ${worktreePath}: ${unmerged.join(", ")}`,
      partialConflicts: resolution.conflicts,
    };
  }

  const filesToScan = [
    ...new Set([
      ...params.conflictFiles,
      ...resolution.conflicts.map((entry) => entry.file),
    ]),
  ];
  const markerFiles: string[] = [];
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
      status: "failed",
      error: `Conflict resolution left conflict markers in: ${markerFiles.join(", ")}`,
      partialConflicts: resolution.conflicts,
    };
  }

  logger.info("conflict-resolution.ground_truth_verified", {
    worktreePath,
    scannedFiles: filesToScan.length,
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
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;

  logger.info("conflict-resolution.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    resolutionContextLength: resolutionContext?.length ?? 0,
    targetBranch: targetBranch ?? null,
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
    const result = await executeWorkflowTaskRun({
      projectPath,
      sessionName,
      conversationId,
      worktreePath,
      kind: "task_run",
      prompt,
      systemInstructions: CONFLICT_RESOLUTION_INSTRUCTIONS,
      outputFormat: {
        type: "json_schema",
        schema: CONFLICT_ENTRIES_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
      },
      origin: { source: "workflow" },
    });

    const resolution = mapTaskRunResultToResolution(result, worktreePath);
    if (resolution.status !== "resolved") return resolution;
    return await verifyResolutionGroundTruth(
      resolution,
      { worktreePath, conflictFiles: conflictFiles ?? [] },
      deps,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("conflict-resolution.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}

function mapTaskRunResultToResolution(
  result: TaskRunResult,
  worktreePath: string,
): ConflictResolutionResult {
  if (result.kind === "error") {
    logger.error("conflict-resolution.task_error", {
      worktreePath,
      error: result.error,
      aborted: result.aborted,
    });
    return { status: "failed", error: result.error };
  }

  const { text, structuredOutput } = extractTextAndStructured(result);
  const parseResult = parseConflictEntries(text, structuredOutput);
  if ("error" in parseResult) {
    logger.warn("conflict-resolution.parse_error", {
      worktreePath,
      error: parseResult.error,
    });
    return { status: "failed", error: parseResult.error };
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
    logger.error("conflict-analysis.task_error", {
      worktreePath,
      error: result.error,
      aborted: result.aborted,
    });
    return { status: "failed", error: result.error };
  }

  const { text, structuredOutput } = extractTextAndStructured(result);
  const parseResult = parseConflictEntries(text, structuredOutput);
  if ("error" in parseResult) {
    logger.warn("conflict-analysis.parse_error", {
      worktreePath,
      error: parseResult.error,
    });
    return { status: "failed", error: parseResult.error };
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
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;

  logger.info("conflict-analysis.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    resolutionContextLength: resolutionContext?.length ?? 0,
    targetBranch: targetBranch ?? null,
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
    const result = await executeWorkflowTaskRun({
      projectPath,
      sessionName,
      conversationId,
      worktreePath,
      kind: "task_run",
      prompt,
      systemInstructions: CONFLICT_ANALYSIS_INSTRUCTIONS,
      outputFormat: {
        type: "json_schema",
        schema: CONFLICT_ENTRIES_OUTPUT_SCHEMA as unknown as Record<
          string,
          unknown
        >,
      },
      origin: { source: "workflow" },
    });

    return mapTaskRunResultToAnalysis(result, worktreePath);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("conflict-analysis.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}
