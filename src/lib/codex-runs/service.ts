/**
 * Codex run job service (docs/design/cc-cli/02 §3.3).
 *
 * `run_codex` becomes a job. `startCodexRun` kicks off a server-side codex
 * execution and returns immediately with a run id; the run continues
 * independently of the initiating request, so it outlives a killed client.
 * `getCodexRun` reports its terminal state and results; `cancelCodexRun` aborts
 * a live run through the injected executor's abort signal (the codex task
 * runner's existing AbortController path).
 *
 * Bookkeeping follows the background-jobs domain convention: the observable run
 * state is a durable SQLite record (codex-runs repo), inserted `running` at
 * start and updated to its terminal state with results when it settles — so a
 * run is represented in the established job bookkeeping domain and survives the
 * request that started it. The only thing that cannot serialize — the live
 * AbortController — lives in an HMR-safe globalThis registry keyed by run id.
 * Execution, filesystem, and artifact-registry side effects are injected so the
 * bookkeeping is exercised without running codex.
 */

import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { CodexReasoningEffort } from "@/lib/agent-backends/schemas";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import {
  CODEX_OUTPUT_SCHEMA,
  parseCodexStructuredResponse,
  wrapCodexPrompt,
} from "@/lib/agent-backends/codex/codex-output";
import {
  createCodexRunRecord,
  getCodexRunRecord,
  updateCodexRunRecord,
} from "./repo";
import type {
  CodexReferenceDocument,
  CodexRunRecord,
  CodexRunStatusResponse,
} from "./schemas";

const logger = createLogger("codex-runs");

const CODEX_OUTPUT_DIR = "memory-bank/codex";

/** Result the executor returns — mirrors the codex task-runner's run outcome. */
export interface CodexExecResult {
  response: string | null;
  structuredOutput?: unknown;
  error: string | null;
  timedOut: boolean;
}

export interface CodexExecInput {
  prompt: string;
  workingDirectory: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Injected side effects: codex execution, directory creation, artifact registration. */
export interface CodexRunServiceDeps {
  ensureDir(dirPath: string): Promise<void>;
  runCodex(input: CodexExecInput): Promise<CodexExecResult>;
  /** When present, structured `referenceDocuments` register into CC's discoverability index. */
  artifactRegistry?: ArtifactRegistry;
  newRunId(): string;
  now(): string;
}

export interface StartCodexRunInput {
  projectName: string;
  sessionName: string;
  prompt: string;
  /** The session worktree — paths returned to the agent are relative to this. */
  worktreePath: string;
  /** Where codex runs; defaults to the worktree, may be a subdirectory of it. */
  workingDirectory: string;
  timeoutMs: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface RunOwner {
  projectName: string;
  sessionName: string;
}

/**
 * The only non-serializable per-run state: the live abort handle. The
 * observable run state (status/results) is the durable SQLite record.
 */
interface CodexRunLiveHandle {
  abort: () => void;
  cancelRequested: boolean;
}

const REGISTRY_KEY = "__cc_codex_runs" as const;

function getRegistry(): Map<string, CodexRunLiveHandle> {
  return getGlobalSingleton(
    REGISTRY_KEY,
    () => new Map<string, CodexRunLiveHandle>(),
  );
}

function ownedBy(record: CodexRunRecord, owner: RunOwner): boolean {
  return (
    record.projectName === owner.projectName &&
    record.sessionName === owner.sessionName
  );
}

function toResponse(record: CodexRunRecord): CodexRunStatusResponse {
  return {
    runId: record.runId,
    status: record.status,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.referenceDocuments !== undefined
      ? { referenceDocuments: record.referenceDocuments }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

/**
 * Start a codex run. Returns the run id synchronously; the run executes in the
 * background and is observed through {@link getCodexRun}.
 */
export function startCodexRun(
  input: StartCodexRunInput,
  deps: CodexRunServiceDeps,
): { runId: string } {
  const runId = deps.newRunId();
  const controller = new AbortController();
  const handle: CodexRunLiveHandle = {
    cancelRequested: false,
    abort: () => {
      handle.cancelRequested = true;
      controller.abort();
    },
  };
  getRegistry().set(runId, handle);

  createCodexRunRecord({
    runId,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: deps.now(),
  });

  logger.info("codex-run.start", {
    runId,
    sessionName: input.sessionName,
    workingDirectory: input.workingDirectory,
    timeoutMs: input.timeoutMs,
    model: input.model ?? "default",
  });

  // Fire-and-forget: the run outlives the initiating request by design.
  void executeRun(runId, handle, input, deps, controller.signal);

  return { runId };
}

async function executeRun(
  runId: string,
  handle: CodexRunLiveHandle,
  input: StartCodexRunInput,
  deps: CodexRunServiceDeps,
  signal: AbortSignal,
): Promise<void> {
  // Non-throwing (like background-jobs' persistTerminalState): a DB write
  // failure in this fire-and-forget path is logged, never surfaced as an
  // unhandled rejection.
  const terminal = (update: {
    status: CodexRunRecord["status"];
    summary?: string;
    referenceDocuments?: CodexReferenceDocument[];
    error?: string;
  }): void => {
    try {
      updateCodexRunRecord(runId, { ...update, completedAt: deps.now() });
    } catch (err) {
      logger.error("codex-run.persist_terminal_failed", {
        runId,
        status: update.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    const outputDir = path.join(input.workingDirectory, CODEX_OUTPUT_DIR);
    await deps.ensureDir(outputDir);

    const result = await deps.runCodex({
      prompt: wrapCodexPrompt(input.prompt),
      workingDirectory: input.workingDirectory,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.reasoningEffort !== undefined
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
      outputSchema: CODEX_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: input.timeoutMs,
      signal,
    });

    if (result.timedOut) {
      if (handle.cancelRequested) {
        terminal({ status: "failed", error: "Codex run cancelled" });
      } else {
        terminal({
          status: "timed_out",
          error:
            input.timeoutMs > 0
              ? `Codex execution timed out after ${input.timeoutMs / 1000} seconds.`
              : "Codex execution timed out.",
        });
      }
      return;
    }

    if (result.error) {
      terminal({ status: "failed", error: normalizeCodexError(result.error) });
      return;
    }

    const structured =
      parseCodexStructuredResponse(result.structuredOutput) ??
      parseCodexStructuredResponse(result.response);

    if (structured) {
      // Codex writes to <workingDirectory>/memory-bank/codex/… and reports
      // filePaths relative to workingDirectory. Everything the agent (and CC's
      // document index) sees must be relative to the session worktree, so
      // translate before registering and before returning them.
      const documents = toWorktreeRelativeDocuments(
        input.worktreePath,
        input.workingDirectory,
        structured.referenceDocuments,
      );
      await registerReferenceDocuments(
        deps.artifactRegistry,
        input.worktreePath,
        runId,
        documents,
      );
      terminal({
        status: "succeeded",
        summary: structured.summary,
        referenceDocuments: documents,
      });
      return;
    }

    if (!result.response) {
      terminal({
        status: "failed",
        error: "Codex completed without emitting a final response.",
      });
      return;
    }

    // Unstructured text fallback: surface the raw response as the summary so the
    // result shape stays uniform (summary + empty referenceDocuments).
    terminal({
      status: "succeeded",
      summary: result.response,
      referenceDocuments: [],
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    terminal({ status: "failed", error });
    logger.error("codex-run.execute_error", { runId, error });
  } finally {
    getRegistry().delete(runId);
    logger.info("codex-run.complete", { runId });
  }
}

/**
 * Translate codex-reported filePaths (relative to `workingDirectory`) into paths
 * relative to the session worktree. When `workingDirectory` is the worktree
 * itself (the default) this is a no-op.
 */
function toWorktreeRelativeDocuments(
  worktreePath: string,
  workingDirectory: string,
  documents: CodexReferenceDocument[],
): CodexReferenceDocument[] {
  return documents.map((doc) => {
    const absolute = path.resolve(workingDirectory, doc.filePath);
    const relative = path.relative(worktreePath, absolute);
    return { filePath: normalizePosix(relative), description: doc.description };
  });
}

function normalizePosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function normalizeCodexError(error: string): string {
  if (error.includes("not found")) {
    return "Codex CLI is not installed or not on PATH. Install @openai/codex on the host machine and authenticate it before enabling this tool.";
  }
  return `Codex execution failed: ${error}`;
}

async function registerReferenceDocuments(
  registry: ArtifactRegistry | undefined,
  worktreePath: string,
  runId: string,
  documents: CodexReferenceDocument[],
): Promise<void> {
  if (!registry || documents.length === 0) return;
  for (const doc of documents) {
    try {
      await registry.register({
        kind: "reference_document",
        worktreePath,
        relativePath: doc.filePath,
        description: doc.description,
        source: {},
      });
    } catch (err) {
      logger.warn("codex-run.register_reference_document_failed", {
        runId,
        filePath: doc.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Read a run's status, scoped to its owning session. Returns null when absent or foreign. */
export function getCodexRun(
  runId: string,
  owner: RunOwner,
): CodexRunStatusResponse | null {
  const record = getCodexRunRecord(runId);
  if (!record || !ownedBy(record, owner)) return null;
  return toResponse(record);
}

export interface CancelResult {
  found: boolean;
  status?: CodexRunRecord["status"];
}

/** Abort a live run (idempotent). Returns not-found for absent or foreign runs. */
export function cancelCodexRun(runId: string, owner: RunOwner): CancelResult {
  const record = getCodexRunRecord(runId);
  if (!record || !ownedBy(record, owner)) return { found: false };
  if (record.status === "running") {
    logger.info("codex-run.cancel", { runId });
    getRegistry().get(runId)?.abort();
  }
  return { found: true, status: record.status };
}

// ============================================================
// Production executor + default deps
// ============================================================

/** Default executor: runs codex through the existing task-runner, threading the cancel signal. */
export async function runCodexJobDefault(
  input: CodexExecInput,
): Promise<CodexExecResult> {
  const runner = getTaskRunner("codex");
  try {
    const result = await runner.run({
      workingDirectory: input.workingDirectory,
      prompt: input.prompt,
      ...(input.model !== undefined ? { modelId: input.model } : {}),
      ...(input.reasoningEffort !== undefined
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
      outputSchema: input.outputSchema,
      autonomous: true,
      timeoutMs: input.timeoutMs,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
      webSearchMode: "disabled",
      signal: input.signal,
    });
    if (result.timedOut) return { response: null, error: null, timedOut: true };
    if (result.error) {
      return { response: null, error: result.error, timedOut: false };
    }
    return {
      response: result.text,
      structuredOutput: result.structuredOutput,
      error: null,
      timedOut: false,
    };
  } catch (err) {
    return {
      response: null,
      error: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
}

export function createDefaultCodexRunServiceDeps(input: {
  artifactRegistry?: ArtifactRegistry;
}): CodexRunServiceDeps {
  return {
    ensureDir: async (dirPath: string) => {
      await mkdir(dirPath, { recursive: true });
    },
    runCodex: runCodexJobDefault,
    ...(input.artifactRegistry !== undefined
      ? { artifactRegistry: input.artifactRegistry }
      : {}),
    newRunId: () => randomUUID(),
    now: () => new Date().toISOString(),
  };
}

/** Test isolation only — clears the in-memory live-handle registry. */
export function _resetForTesting(): void {
  getRegistry().clear();
}
