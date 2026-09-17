/**
 * Per-execution structured log system for graph workflow observability.
 *
 * Writes separate log files per execution, organized by concern:
 * - _manifest.json: index + metadata (entry point for investigation)
 * - lifecycle.jsonl: execution-level events
 * - contexts/<id>/iterations.jsonl: per-context iteration events
 * - contexts/<id>/tasks.jsonl: task completion, validation failures, agent-added tasks
 * - contexts/<id>/validation.jsonl: validator invocations + results
 * - contexts/<id>/prompts/: full prompt text + validator responses
 * - decisions.jsonl: cross-cutting decision log (rotation, circuit breaker)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseJsonl } from "@/lib/shared/read-jsonl";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { resolveConfigDir } from "@/lib/config/loader";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { ResolvedWorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
// -- Configuration -----------------------------------------------------------

const WORKFLOW_LOGS_DIR = "workflow-logs";

export interface ExecutionLoggerDeps {
  configDir?: string;
  now?(): string;
}

function resolveLogsBaseDir(configDir?: string): string {
  return path.join(configDir ?? resolveConfigDir(), WORKFLOW_LOGS_DIR);
}

// -- Core I/O ----------------------------------------------------------------

function ensureDir(dirPath: string): void {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  } catch {
    // Silent — if we can't create the dir, writes will fail silently later
  }
}

function appendJsonl(filePath: string, entry: Record<string, unknown>): void {
  try {
    ensureDir(path.dirname(filePath));
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never throw — silently drop on write failure
  }
}

function writeJson(filePath: string, data: unknown): void {
  try {
    ensureDir(path.dirname(filePath));
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // Never throw
  }
}

function writeText(filePath: string, text: string): void {
  try {
    ensureDir(path.dirname(filePath));
    writeFileSync(filePath, text, "utf-8");
  } catch {
    // Never throw
  }
}

// -- Manifest ----------------------------------------------------------------

interface ManifestContextSummary {
  contextId: string;
  title: string;
  iterationCount: number;
  totalTasks: number;
  completedTasks: number;
}

interface Manifest {
  executionId: string;
  definitionId: string | null;
  definitionRevision: number | null;
  definition: ResolvedWorkflowSemanticDefinition;
  startedAt: string;
  completedAt: string | null;
  status: string;
  haltReason: GraphWorkflowHaltReason | null;
  contexts: ManifestContextSummary[];
  files: Record<string, string>;
}

/**
 * Where one validator assignment's artifacts live. A context reviewed by a
 * cohort produces one prompt, response, and transcript PER specialist; without
 * the assignment segment the last reviewer of each round would overwrite the
 * others' evidence and a failed round would be unreconstructable.
 */
export interface ValidatorArtifactScope {
  contextId: string;
  assignmentId: string;
}

// -- Logger factory ----------------------------------------------------------

export interface ExecutionLogger {
  readonly executionId: string;
  readonly logDir: string;

  // Manifest
  writeManifest(execution: GraphWorkflowExecution): void;

  // Lifecycle events
  lifecycle(event: string, data?: Record<string, unknown>): void;

  // Per-context events
  iteration(
    contextId: string,
    event: string,
    data?: Record<string, unknown>,
  ): void;
  task(contextId: string, event: string, data?: Record<string, unknown>): void;
  validation(
    contextId: string,
    event: string,
    data?: Record<string, unknown>,
  ): void;

  // Prompt/response storage
  writePrompt(
    scope: string | ValidatorArtifactScope,
    filename: string,
    content: string,
  ): void;
  writeValidatorResponse(
    scope: ValidatorArtifactScope,
    filename: string,
    data: {
      raw: string;
      parsed: unknown;
      parsePath: string;
    },
  ): void;

  /**
   * Append a validator's full agent transcript (reasoning, tool/command items,
   * messages) to that assignment's `validation-transcript.jsonl`, alongside
   * the verdict events in the context's `validation.jsonl`. Each invocation is
   * preceded by a `validator.transcript_begin` marker carrying an `attempt`
   * counter that increments per (context, assignment, lane) so re-validations
   * stay distinguishable. A no-op when `entries` is empty (e.g. a timed-out or
   * errored turn that produced no items).
   */
  writeValidatorTranscript(
    scope: ValidatorArtifactScope,
    meta: { lane: string; engine: AgentBackendId },
    entries: AgentTranscriptEntry[],
  ): void;

  // Cross-cutting decisions
  decision(event: string, data?: Record<string, unknown>): void;
}

export function createExecutionLogger(
  executionId: string,
  deps: ExecutionLoggerDeps = {},
): ExecutionLogger {
  const logsBase = resolveLogsBaseDir(deps.configDir);
  const logDir = path.join(logsBase, executionId);
  const getNow = deps.now ?? (() => new Date().toISOString());

  // Per-(context, lane) validator-transcript invocation counter, so each
  // re-validation gets a distinct `attempt` in its begin-marker.
  const transcriptAttempts = new Map<string, number>();

  function timestamped(
    event: string,
    data?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      timestamp: getNow(),
      event,
      executionId,
      ...data,
    };
  }

  function lifecyclePath(): string {
    return path.join(logDir, "lifecycle.jsonl");
  }

  function contextDir(contextId: string): string {
    return path.join(logDir, "contexts", contextId);
  }

  /** `contexts/<contextId>/validators/<assignmentId>/`. */
  function validatorDir(scope: ValidatorArtifactScope): string {
    return path.join(
      contextDir(scope.contextId),
      "validators",
      scope.assignmentId,
    );
  }

  function decisionsPath(): string {
    return path.join(logDir, "decisions.jsonl");
  }

  function nextTranscriptAttempt(
    scope: ValidatorArtifactScope,
    lane: string,
    filePath: string,
  ): number {
    const contextId = scope.contextId;
    const attemptKey = `${contextId}:${scope.assignmentId}:${lane}`;
    const cached = transcriptAttempts.get(attemptKey);
    if (cached !== undefined) {
      transcriptAttempts.set(attemptKey, cached + 1);
      return cached;
    }

    let nextAttempt = 0;
    try {
      if (existsSync(filePath)) {
        for (const parsed of parseJsonl(readFileSync(filePath, "utf-8"))) {
          const entry = parsed as Record<string, unknown>;
          if (
            entry.event === "validator.transcript_begin" &&
            entry.contextId === contextId &&
            entry.lane === lane &&
            Number.isInteger(entry.attempt)
          ) {
            nextAttempt = Math.max(nextAttempt, Number(entry.attempt) + 1);
          }
        }
      }
    } catch {
      // Preserve logging's best-effort contract when existing log data is unreadable.
    }

    transcriptAttempts.set(attemptKey, nextAttempt + 1);
    return nextAttempt;
  }

  return {
    executionId,
    logDir,

    writeManifest(execution: GraphWorkflowExecution): void {
      const contexts: ManifestContextSummary[] =
        execution.workingDefinition.executionContexts.map((ctx) => {
          const state = execution.contextStates[ctx.id];
          return {
            contextId: ctx.id,
            title: ctx.title,
            iterationCount: state?.iterationCount ?? 0,
            totalTasks: state?.totalTaskCount ?? 0,
            completedTasks: state?.completedTaskCount ?? 0,
          };
        });

      const manifest: Manifest = {
        executionId: execution.id,
        definitionId: execution.seedDefinitionId,
        definitionRevision: execution.seedDefinitionRevision,
        definition: execution.workingDefinition,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        status: execution.status,
        haltReason: execution.haltReason,
        contexts,
        files: {
          "_manifest.json":
            "Execution metadata, definition, context summaries. START HERE.",
          "lifecycle.jsonl":
            "Execution-level events: start, context scheduling, halt, complete.",
          "contexts/<id>/iterations.jsonl":
            "Per-context iteration lifecycle: start, follow-ups, completion.",
          "contexts/<id>/tasks.jsonl":
            "Task completions, agent-added tasks, validation feedback.",
          "contexts/<id>/validation.jsonl":
            "Validator invocations and results, for the whole cohort.",
          "contexts/<id>/validators/<assignmentId>/validation-transcript.jsonl":
            "One cohort member's full agent transcripts (reasoning, tool/command items, messages), one begin-marker + item events per invocation.",
          "contexts/<id>/validators/<assignmentId>/":
            "One cohort member's validation prompt (.md) and parsed response (.json).",
          "contexts/<id>/prompts/": "Full implementer prompt text (.md).",
          "decisions.jsonl":
            "Cross-cutting: rotation and circuit breaker decisions.",
        },
      };

      writeJson(path.join(logDir, "_manifest.json"), manifest);
    },

    lifecycle(event: string, data?: Record<string, unknown>): void {
      appendJsonl(lifecyclePath(), timestamped(event, data));
    },

    iteration(
      contextId: string,
      event: string,
      data?: Record<string, unknown>,
    ): void {
      appendJsonl(
        path.join(contextDir(contextId), "iterations.jsonl"),
        timestamped(event, { contextId, ...data }),
      );
    },

    task(
      contextId: string,
      event: string,
      data?: Record<string, unknown>,
    ): void {
      appendJsonl(
        path.join(contextDir(contextId), "tasks.jsonl"),
        timestamped(event, { contextId, ...data }),
      );
    },

    validation(
      contextId: string,
      event: string,
      data?: Record<string, unknown>,
    ): void {
      appendJsonl(
        path.join(contextDir(contextId), "validation.jsonl"),
        timestamped(event, { contextId, ...data }),
      );
    },

    writePrompt(
      scope: string | ValidatorArtifactScope,
      filename: string,
      content: string,
    ): void {
      const dir =
        typeof scope === "string"
          ? path.join(contextDir(scope), "prompts")
          : validatorDir(scope);
      writeText(path.join(dir, filename), content);
    },

    writeValidatorResponse(
      scope: ValidatorArtifactScope,
      filename: string,
      data: {
        raw: string;
        parsed: unknown;
        parsePath: string;
      },
    ): void {
      writeJson(path.join(validatorDir(scope), filename), data);
    },

    writeValidatorTranscript(
      scope: ValidatorArtifactScope,
      meta: { lane: string; engine: AgentBackendId },
      entries: AgentTranscriptEntry[],
    ): void {
      if (entries.length === 0) return;

      const filePath = path.join(
        validatorDir(scope),
        "validation-transcript.jsonl",
      );
      const attempt = nextTranscriptAttempt(scope, meta.lane, filePath);
      appendJsonl(
        filePath,
        timestamped("validator.transcript_begin", {
          contextId: scope.contextId,
          assignmentId: scope.assignmentId,
          lane: meta.lane,
          engine: meta.engine,
          attempt,
          entryCount: entries.length,
        }),
      );
      for (const entry of entries) {
        appendJsonl(
          filePath,
          timestamped("validator.transcript_item", {
            contextId: scope.contextId,
            assignmentId: scope.assignmentId,
            attempt,
            seq: entry.seq,
            backend: entry.backend,
            itemType: entry.type,
            raw: entry.raw,
          }),
        );
      }
    },

    decision(event: string, data?: Record<string, unknown>): void {
      appendJsonl(decisionsPath(), timestamped(event, data));
    },
  };
}

// -- Registry ----------------------------------------------------------------
// Maps executionId → ExecutionLogger, so all modules can access the logger
// for the currently running execution without passing it through every call.
// Hosted on globalThis, like the active-loop registry in execution-loop.ts:
// Next.js evaluates route handlers in separate module graphs, and the start,
// pause and resume routes each compose their own manager, so a module-local
// map would leave the pause route unable to find the logger the start route
// registered and lifecycle.jsonl would record the resume without its pause.

const EXECUTION_LOGGER_REGISTRY_KEY =
  "__cc_graph_workflow_execution_loggers" as const;

function registry(): Map<string, ExecutionLogger> {
  return getGlobalSingleton(
    EXECUTION_LOGGER_REGISTRY_KEY,
    () => new Map<string, ExecutionLogger>(),
  );
}

export function registerExecutionLogger(logger: ExecutionLogger): void {
  registry().set(logger.executionId, logger);
}

export function unregisterExecutionLogger(executionId: string): void {
  registry().delete(executionId);
}

export function getExecutionLogger(
  executionId: string,
): ExecutionLogger | null {
  return registry().get(executionId) ?? null;
}

/** Reset the registry (for testing only). */
export function _resetRegistryForTesting(): void {
  registry().clear();
}
