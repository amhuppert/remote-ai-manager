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
import { resolveConfigDir } from "@/lib/config/loader";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { AgentBackendId } from "@/lib/agent-backends/types";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
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
  definitionId: string;
  definitionRevision: number;
  definition: ResolvedWorkflowSemanticDefinition;
  startedAt: string;
  completedAt: string | null;
  status: string;
  haltReason: GraphWorkflowHaltReason | null;
  contexts: ManifestContextSummary[];
  files: Record<string, string>;
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
  writePrompt(contextId: string, filename: string, content: string): void;
  writeValidatorResponse(
    contextId: string,
    filename: string,
    data: {
      raw: string;
      parsed: unknown;
      parsePath: string;
    },
  ): void;

  /**
   * Append a validator's full agent transcript (reasoning, tool/command items,
   * messages) to `contexts/<contextId>/validation-transcript.jsonl`, alongside
   * the verdict events in `validation.jsonl`. Each invocation is preceded by a
   * `validator.transcript_begin` marker carrying an `attempt` counter that
   * increments per (context, lane) so re-validations stay distinguishable.
   * A no-op when `entries` is empty (e.g. a timed-out or errored turn that
   * produced no items).
   */
  writeValidatorTranscript(
    contextId: string,
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

  function decisionsPath(): string {
    return path.join(logDir, "decisions.jsonl");
  }

  function nextTranscriptAttempt(
    contextId: string,
    lane: string,
    filePath: string,
  ): number {
    const attemptKey = `${contextId}:${lane}`;
    const cached = transcriptAttempts.get(attemptKey);
    if (cached !== undefined) {
      transcriptAttempts.set(attemptKey, cached + 1);
      return cached;
    }

    let nextAttempt = 0;
    try {
      if (existsSync(filePath)) {
        for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as Record<string, unknown>;
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
            "Validator invocations and results.",
          "contexts/<id>/validation-transcript.jsonl":
            "Full validator agent transcripts (reasoning, tool/command items, messages), one begin-marker + item events per invocation.",
          "contexts/<id>/prompts/":
            "Full prompt text (.md) and validator responses (.json).",
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

    writePrompt(contextId: string, filename: string, content: string): void {
      writeText(path.join(contextDir(contextId), "prompts", filename), content);
    },

    writeValidatorResponse(
      contextId: string,
      filename: string,
      data: {
        raw: string;
        parsed: unknown;
        parsePath: string;
      },
    ): void {
      writeJson(path.join(contextDir(contextId), "prompts", filename), data);
    },

    writeValidatorTranscript(
      contextId: string,
      meta: { lane: string; engine: AgentBackendId },
      entries: AgentTranscriptEntry[],
    ): void {
      if (entries.length === 0) return;

      const filePath = path.join(
        contextDir(contextId),
        "validation-transcript.jsonl",
      );
      const attempt = nextTranscriptAttempt(contextId, meta.lane, filePath);
      appendJsonl(
        filePath,
        timestamped("validator.transcript_begin", {
          contextId,
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
            contextId,
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

const registry = new Map<string, ExecutionLogger>();

export function registerExecutionLogger(logger: ExecutionLogger): void {
  registry.set(logger.executionId, logger);
}

export function unregisterExecutionLogger(executionId: string): void {
  registry.delete(executionId);
}

export function getExecutionLogger(
  executionId: string,
): ExecutionLogger | null {
  return registry.get(executionId) ?? null;
}

/** Reset the registry (for testing only). */
export function _resetRegistryForTesting(): void {
  registry.clear();
}
