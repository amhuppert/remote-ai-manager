import { z } from "zod";
import { conflictEntrySchema } from "./schemas";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/schemas";
import { readConfig as defaultReadConfig } from "./config";
import { assertNever } from "./assert-never";
import { createLogger } from "./logging";
import { getTaskRunner as defaultGetTaskRunner } from "./agent-backends/registry";
import type { AgentTaskRunner, AgentTaskResult } from "./agent-backends/task";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallFacadeDeps } from "@/lib/workflows/primitives/agent-call-facade";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";

const logger = createLogger("conflict-resolution");

// Anthropic tool input_schema requires `type: "object"` at the root, so the
// array of entries is wrapped under a `conflicts` property.
export const CONFLICT_ENTRIES_OUTPUT_SCHEMA = {
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
  getTaskRunner(backend: "claude"): AgentTaskRunner;
  readConfig: typeof defaultReadConfig;
  /**
   * Optional override for the AgentCall primitive entry point. The smart-merge
   * resolver and analyzer route their task-style turns through
   * `executeAgentCall` so the facade applies the structured-output gate and
   * uniform failure normalization across the primitive layer.
   */
  executeAgentCall?: (
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ) => Promise<AgentCallResult>;
}

const defaultDeps: ConflictResolutionDeps = {
  getTaskRunner: defaultGetTaskRunner,
  readConfig: defaultReadConfig,
};

function agentCallResultToTaskResult(result: AgentCallResult): AgentTaskResult {
  if (result.outcome.kind === "completed") {
    const completed: AgentTaskResult = {
      text: result.outcome.text,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          }
        : null,
      error: null,
      timedOut: false,
      backendRef: result.backendRef ?? null,
    };
    if (result.outcome.structuredOutput !== undefined) {
      completed.structuredOutput = result.outcome.structuredOutput;
    }
    return completed;
  }

  if (result.outcome.kind === "failed") {
    return {
      text: null,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            cachedInputTokens: result.usage.cachedInputTokens ?? null,
          }
        : null,
      error: result.outcome.error.message,
      timedOut: result.outcome.error.failureKind === "timeout",
      backendRef: result.backendRef ?? null,
    };
  }

  return {
    text: null,
    usage: null,
    error: `conflict resolver paused unexpectedly (pauseKind=${result.outcome.pauseKind})`,
    timedOut: false,
    backendRef: result.backendRef ?? null,
  };
}

interface ConflictAgentCallInvocation {
  prompt: string;
  systemInstructions: string;
  workingDirectory: string;
  timeoutMs: number;
  writeCapability: "write_capable" | "read_only";
}

async function dispatchConflictAgentCall(
  invocation: ConflictAgentCallInvocation,
  deps: ConflictResolutionDeps,
): Promise<AgentTaskResult> {
  const executeAgentCall = deps.executeAgentCall ?? defaultExecuteAgentCall;
  const runner = deps.getTaskRunner("claude");

  const request: AgentCallRequest = {
    kind: "task_run",
    backend: "claude",
    prompt: invocation.prompt,
    systemInstructions: invocation.systemInstructions,
    writeCapability: invocation.writeCapability,
    timeoutMs: invocation.timeoutMs,
    outputSchema: CONFLICT_ENTRIES_OUTPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
  };

  const result = await executeAgentCall(request, {
    resolveTaskRunner: () => ({
      runner,
      capabilityView: capabilityViewForBackend("claude"),
      workingDirectory: invocation.workingDirectory,
      autonomous: true,
      defaultTimeoutMs: invocation.timeoutMs,
    }),
  });

  return agentCallResultToTaskResult(result);
}

// ============================================================
// Public Types
// ============================================================

export type ConflictResolutionResult =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | { status: "failed"; error: string; partialConflicts?: ConflictEntry[] };

export type ConflictAnalysisResult =
  | { status: "analyzed"; conflicts: ConflictEntry[] }
  | { status: "failed"; error: string };

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
- Stage every resolved file with git add.`;

const CONFLICT_ANALYSIS_INSTRUCTIONS = `You are a merge conflict analysis specialist. Your task is to analyze all git merge conflicts in this worktree and describe them, WITHOUT resolving them.

Follow these steps precisely:

1. Run \`git diff --name-only --diff-filter=U\` to find all conflicted files.
2. Read each conflicted file and analyze the conflict markers (<<<<<<< HEAD, =======, >>>>>>> markers).
3. For each file, understand the intent of both sides and propose how the conflict should be resolved.
4. Return your analysis as the structured output the response schema requires (one entry per conflicted file).

IMPORTANT:
- DO NOT edit any files. DO NOT remove conflict markers. DO NOT run git add. This is analysis only.
- Analyze ALL conflicted files before producing the structured output.`;

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
// JSON Extraction
// ============================================================

/**
 * Scan text for the last ```json code fence and return its content.
 * Returns null if no code fence is found.
 */
function extractLastJsonCodeFence(text: string): string | null {
  const regex = /```json\s*\n([\s\S]*?)```/g;
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    lastMatch = match[1] ?? null;
  }

  return lastMatch?.trim() ?? null;
}

// ============================================================
// Conflict Entry Parsing (resilience order)
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
 * Parse conflict entries from task runner output using a resilience chain:
 * 1. Structured output (if the runner returned it via outputSchema)
 * 2. Raw JSON parse of the full text
 * 3. Fenced ```json block extraction
 */
function parseConflictEntries(
  text: string | null,
  structuredOutput: unknown,
): { conflicts: ConflictEntry[] } | { error: string } {
  // 1. Structured output
  if (structuredOutput != null) {
    const parseResult =
      conflictEntriesPayloadSchema.safeParse(structuredOutput);
    if (parseResult.success) {
      logger.debug("conflict-resolution.parsed_via_structured_output");
      return { conflicts: unwrapEntries(parseResult.data) };
    }
    logger.debug("conflict-resolution.structured_output_invalid", {
      error: parseResult.error.message,
    });
  }

  if (!text) {
    return { error: "No text output from task runner" };
  }

  // 2. Raw JSON parse of the full text
  try {
    const parsed = JSON.parse(text);
    const parseResult = conflictEntriesPayloadSchema.safeParse(parsed);
    if (parseResult.success) {
      logger.debug("conflict-resolution.parsed_via_raw_json");
      return { conflicts: unwrapEntries(parseResult.data) };
    }
  } catch {
    // Not valid JSON — fall through to fenced block extraction
  }

  // 3. Fenced ```json block extraction
  const jsonContent = extractLastJsonCodeFence(text);
  if (!jsonContent) {
    return { error: "No JSON code fence found in agent's response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Invalid JSON";
    return { error: `Failed to parse conflict entries JSON: ${errorMsg}` };
  }

  const parseResult = conflictEntriesPayloadSchema.safeParse(parsed);
  if (!parseResult.success) {
    return {
      error: `Failed to parse conflict entries: ${parseResult.error.message}`,
    };
  }

  logger.debug("conflict-resolution.parsed_via_fenced_block");
  return { conflicts: unwrapEntries(parseResult.data) };
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
    resolveConflicts: (params: {
      worktreePath: string;
      decisions?: ConflictDecisionInput[];
    }): Promise<ConflictResolutionResult> => resolveConflictsImpl(params, deps),
    analyzeConflicts: (params: {
      worktreePath: string;
    }): Promise<ConflictAnalysisResult> => analyzeConflictsImpl(params, deps),
  };
}

/**
 * Resolve merge conflicts via the task runner.
 *
 * - Constructs the conflict resolution prompt
 * - Runs via the Claude task runner with full tool access
 * - Extracts structured ConflictEntry[] using resilience chain
 * - Returns resolved status with entries on success, or failed status with error
 */
export async function resolveConflicts(params: {
  worktreePath: string;
  decisions?: ConflictDecisionInput[];
}): Promise<ConflictResolutionResult> {
  return resolveConflictsImpl(params, defaultDeps);
}

async function resolveConflictsImpl(
  params: {
    worktreePath: string;
    decisions?: ConflictDecisionInput[];
  },
  deps: ConflictResolutionDeps,
): Promise<ConflictResolutionResult> {
  const { worktreePath, decisions } = params;
  const { readConfig } = deps;

  logger.info("conflict-resolution.start", { worktreePath });

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to read config";
    logger.error("conflict-resolution.config_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  let prompt =
    "Resolve all merge conflicts in this worktree. Follow the instructions in your system prompt precisely.";

  if (decisions && decisions.length > 0) {
    prompt += buildDecisionsPrompt(decisions);
  }

  try {
    const result = await dispatchConflictAgentCall(
      {
        prompt,
        systemInstructions: CONFLICT_RESOLUTION_INSTRUCTIONS,
        workingDirectory: worktreePath,
        timeoutMs: config.claudeTimeoutMs,
        writeCapability: "write_capable",
      },
      deps,
    );

    if (result.error) {
      logger.error("conflict-resolution.task_error", {
        worktreePath,
        error: result.error,
        timedOut: result.timedOut,
      });
      return { status: "failed", error: result.error };
    }

    const parseResult = parseConflictEntries(
      result.text,
      result.structuredOutput,
    );
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("conflict-resolution.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}

// ============================================================
// Analyze Conflicts (analysis-only, no file edits)
// ============================================================

/**
 * Analyze merge conflicts without resolving them via the task runner.
 * Produces structured ConflictEntry[] describing each conflict and a proposed resolution,
 * but does NOT edit files or remove conflict markers.
 */
export async function analyzeConflicts(params: {
  worktreePath: string;
}): Promise<ConflictAnalysisResult> {
  return analyzeConflictsImpl(params, defaultDeps);
}

async function analyzeConflictsImpl(
  params: { worktreePath: string },
  deps: ConflictResolutionDeps,
): Promise<ConflictAnalysisResult> {
  const { worktreePath } = params;
  const { readConfig } = deps;

  logger.info("conflict-analysis.start", { worktreePath });

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to read config";
    logger.error("conflict-analysis.config_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  const prompt =
    "Analyze all merge conflicts in this worktree. Follow the instructions in your system prompt precisely. Do NOT edit any files.";

  try {
    const result = await dispatchConflictAgentCall(
      {
        prompt,
        systemInstructions: CONFLICT_ANALYSIS_INSTRUCTIONS,
        workingDirectory: worktreePath,
        timeoutMs: config.claudeTimeoutMs,
        writeCapability: "read_only",
      },
      deps,
    );

    if (result.error) {
      logger.error("conflict-analysis.task_error", {
        worktreePath,
        error: result.error,
        timedOut: result.timedOut,
      });
      return { status: "failed", error: result.error };
    }

    const parseResult = parseConflictEntries(
      result.text,
      result.structuredOutput,
    );
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("conflict-analysis.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}
