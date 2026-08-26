/**
 * Agent run job service: a one-shot backend task run as a job.
 *
 * `startAgentRun` kicks off a server-side agent execution on the requested
 * backend and returns immediately with a run id; the run continues
 * independently of the initiating request, so it outlives a killed client.
 * `getAgentRun` reports its terminal state and results; `cancelAgentRun`
 * aborts a live run through the injected executor's abort signal (the task
 * runner's existing AbortController path).
 *
 * Bookkeeping follows the background-jobs domain convention: the observable
 * run state is a durable SQLite record (agent-runs repo), inserted `running`
 * at start and updated to its terminal state with results when it settles.
 * The only thing that cannot serialize — the live AbortController — lives in
 * the shared abort registry under `agent-run:<runId>`. Structured results flow
 * through the neutral `outputSchema` request and shared extraction fallback
 * (`@/lib/agent-backends/structured-output`) — no bespoke parser. Execution,
 * filesystem, and artifact-registry side effects are injected so the
 * bookkeeping is exercised without running a real backend.
 */

import { mkdir } from "node:fs/promises";
import { getErrorMessage } from "@/lib/shared/errors";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import { backendLabel } from "@/lib/agent-backends/catalog";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
import {
  getAbortHandle,
  registerAbortHandle,
  releaseAbortHandle,
  _resetAbortRegistryForTesting,
  type AbortHandleKey,
} from "@/lib/shared/abort-registry";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import { createAgentRunsRepo } from "./repo";
import { getStateDb } from "../state-store/store";
import { AGENT_RUN_OUTPUT_SCHEMA, agentRunOutputSchema } from "./schemas";
import type {
  AgentRunReferenceDocument,
  AgentRunRecord,
  AgentRunStatusResponse,
} from "./schemas";

const logger = createLogger("agent-runs");

const AGENT_RUN_OUTPUT_DIR = "memory-bank/agent-runs";

/**
 * The run contract the sub-agent works under: detail goes to files under the
 * output directory, the response is the summary + referenceDocuments shape.
 * This is domain instruction (where to write, what the fields mean) — the
 * response shape is carried by the neutral `outputSchema` contract and checked
 * after extraction; this text owns the domain-specific file and summary rules.
 */
const AGENT_RUN_PROMPT_PREAMBLE = `You MUST write all detailed output as files in the \`${AGENT_RUN_OUTPUT_DIR}/\` directory (relative to the workspace root). Use markdown files primarily, but other formats are acceptable when appropriate.

Your final response must be a JSON object with two fields:
- "summary": A concise summary of what you did and the results. Maximum 1000 characters. This is the only text the caller sees directly, so make it informative.
- "referenceDocuments": An array of documents you created, each with "filePath" (path relative to workspace root) and "description" (what the file contains and when it should be read).

Write detailed analysis, code examples, plans, and explanations to files — do NOT put them in the summary.`;

function composeRunPrompt(prompt: string): string {
  return `${AGENT_RUN_PROMPT_PREAMBLE}\n\n---\n\nTask:\n${prompt}`;
}

/** Result the executor returns — mirrors the task-runner's run outcome. */
export interface AgentRunExecResult {
  response: string | null;
  structuredOutput?: unknown;
  error: string | null;
  timedOut: boolean;
}

export interface AgentRunExecInput {
  backend: AgentBackendId;
  prompt: string;
  workingDirectory: string;
  modelSelection: BackendModelSelection;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Injected side effects: agent execution, directory creation, artifact registration. */
export interface AgentRunServiceDeps {
  ensureDir(dirPath: string): Promise<void>;
  runTask(input: AgentRunExecInput): Promise<AgentRunExecResult>;
  /** When present, structured `referenceDocuments` register into CC's discoverability index. */
  artifactRegistry?: ArtifactRegistry;
  newRunId(): string;
  now(): string;
}

export interface StartAgentRunInput {
  backend: AgentBackendId;
  projectName: string;
  sessionName: string;
  prompt: string;
  /** The session worktree — paths returned to the agent are relative to this. */
  worktreePath: string;
  /** Where the agent runs; defaults to the worktree, may be a subdirectory of it. */
  workingDirectory: string;
  timeoutMs: number;
  modelSelection: BackendModelSelection;
}

export interface RunOwner {
  projectName: string;
  sessionName: string;
}

function abortKeyFor(runId: string): AbortHandleKey {
  return `agent-run:${runId}`;
}

function ownedBy(record: AgentRunRecord, owner: RunOwner): boolean {
  return (
    record.projectName === owner.projectName &&
    record.sessionName === owner.sessionName
  );
}

function toResponse(record: AgentRunRecord): AgentRunStatusResponse {
  return {
    runId: record.runId,
    backend: record.backend,
    status: record.status,
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...(record.referenceDocuments !== undefined
      ? { referenceDocuments: record.referenceDocuments }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

/**
 * Start an agent run. Returns the run id synchronously; the run executes in
 * the background and is observed through {@link getAgentRun}.
 */
export function startAgentRun(
  input: StartAgentRunInput,
  deps: AgentRunServiceDeps,
): { runId: string } {
  const runId = deps.newRunId();
  const controller = new AbortController();
  registerAbortHandle(abortKeyFor(runId), controller);

  createAgentRunsRepo(getStateDb()).createAgentRunRecord({
    runId,
    backend: input.backend,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: deps.now(),
    ownerPid: process.pid,
  });

  logger.info("agent-run.start", {
    runId,
    backend: input.backend,
    sessionName: input.sessionName,
    workingDirectory: input.workingDirectory,
    timeoutMs: input.timeoutMs,
    modelId: input.modelSelection.modelId,
    parameterIds: Object.keys(input.modelSelection.parameters).sort(),
  });

  // Fire-and-forget: the run outlives the initiating request by design.
  void executeRun(runId, input, deps, controller.signal);

  return { runId };
}

async function executeRun(
  runId: string,
  input: StartAgentRunInput,
  deps: AgentRunServiceDeps,
  signal: AbortSignal,
): Promise<void> {
  // Non-throwing (like background-jobs' persistTerminalState): a DB write
  // failure in this fire-and-forget path is logged, never surfaced as an
  // unhandled rejection.
  const terminal = (update: {
    status: AgentRunRecord["status"];
    summary?: string;
    referenceDocuments?: AgentRunReferenceDocument[];
    error?: string;
  }): void => {
    try {
      createAgentRunsRepo(getStateDb()).updateAgentRunRecord(runId, {
        ...update,
        completedAt: deps.now(),
      });
    } catch (err) {
      logger.error("agent-run.persist_terminal_failed", {
        runId,
        status: update.status,
        error: getErrorMessage(err),
      });
    }
  };

  try {
    const outputDir = path.join(input.workingDirectory, AGENT_RUN_OUTPUT_DIR);
    await deps.ensureDir(outputDir);

    const result = await deps.runTask({
      backend: input.backend,
      prompt: composeRunPrompt(input.prompt),
      workingDirectory: input.workingDirectory,
      modelSelection: input.modelSelection,
      outputSchema: AGENT_RUN_OUTPUT_SCHEMA,
      timeoutMs: input.timeoutMs,
      signal,
    });

    if (result.timedOut) {
      // The runner reports an external abort through the same timedOut path a
      // real timeout uses; the registered signal tells the two apart.
      if (signal.aborted) {
        terminal({ status: "failed", error: "Agent run cancelled" });
      } else {
        terminal({
          status: "failed",
          error:
            input.timeoutMs > 0
              ? `Agent execution timed out after ${input.timeoutMs / 1000} seconds.`
              : "Agent execution timed out.",
        });
      }
      return;
    }

    if (result.error) {
      terminal({
        status: "failed",
        error: normalizeRunError(input.backend, result.error),
      });
      return;
    }

    const structured = validateStructuredOutput(agentRunOutputSchema, {
      ...(result.structuredOutput !== undefined
        ? { native: result.structuredOutput }
        : {}),
      text: result.response,
    });

    if (structured.ok) {
      // The agent writes to <workingDirectory>/memory-bank/agent-runs/… and
      // reports filePaths relative to workingDirectory. Everything the caller
      // (and CC's document index) sees must be relative to the session
      // worktree, so translate before registering and before returning them.
      const documents = toWorktreeRelativeDocuments(
        input.worktreePath,
        input.workingDirectory,
        structured.value.referenceDocuments,
      );
      await registerReferenceDocuments(
        deps.artifactRegistry,
        input.worktreePath,
        runId,
        documents,
      );
      terminal({
        status: "completed",
        summary: structured.value.summary,
        referenceDocuments: documents,
      });
      return;
    }

    if (!result.response) {
      terminal({
        status: "failed",
        error: "Agent completed without emitting a final response.",
      });
      return;
    }

    // Unstructured text fallback: surface the raw response as the summary so the
    // result shape stays uniform (summary + empty referenceDocuments).
    terminal({
      status: "completed",
      summary: result.response,
      referenceDocuments: [],
    });
  } catch (err) {
    const error = getErrorMessage(err);
    terminal({ status: "failed", error });
    logger.error("agent-run.execute_error", { runId, error });
  } finally {
    releaseAbortHandle(abortKeyFor(runId));
    logger.info("agent-run.complete", { runId });
  }
}

/**
 * Translate agent-reported filePaths (relative to `workingDirectory`) into
 * paths relative to the session worktree. When `workingDirectory` is the
 * worktree itself (the default) this is a no-op.
 */
function toWorktreeRelativeDocuments(
  worktreePath: string,
  workingDirectory: string,
  documents: AgentRunReferenceDocument[],
): AgentRunReferenceDocument[] {
  return documents.map((doc) => {
    const absolute = path.resolve(workingDirectory, doc.filePath);
    const relative = path.relative(worktreePath, absolute);
    return { filePath: normalizePosix(relative), description: doc.description };
  });
}

function normalizePosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function normalizeRunError(backend: AgentBackendId, error: string): string {
  if (error.includes("not found")) {
    return `The ${backendLabel(backend)} CLI is not installed or not on PATH. Install and authenticate it on the host machine before running this backend.`;
  }
  return `Agent execution failed: ${error}`;
}

async function registerReferenceDocuments(
  registry: ArtifactRegistry | undefined,
  worktreePath: string,
  runId: string,
  documents: AgentRunReferenceDocument[],
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
      logger.warn("agent-run.register_reference_document_failed", {
        runId,
        filePath: doc.filePath,
        error: getErrorMessage(err),
      });
    }
  }
}

/** Read a run's status, scoped to its owning session. Returns null when absent or foreign. */
export function getAgentRun(
  runId: string,
  owner: RunOwner,
): AgentRunStatusResponse | null {
  const record = createAgentRunsRepo(getStateDb()).getAgentRunRecord(runId);
  if (!record || !ownedBy(record, owner)) return null;
  return toResponse(record);
}

export interface CancelResult {
  found: boolean;
  status?: AgentRunRecord["status"];
}

/** Abort a live run (idempotent). Returns not-found for absent or foreign runs. */
export function cancelAgentRun(runId: string, owner: RunOwner): CancelResult {
  const record = createAgentRunsRepo(getStateDb()).getAgentRunRecord(runId);
  if (!record || !ownedBy(record, owner)) return { found: false };
  if (record.status === "running") {
    logger.info("agent-run.cancel", { runId });
    // Abort without releasing: executeRun observes signal.aborted to classify
    // the settle as a cancellation, then releases in its finally.
    getAbortHandle(abortKeyFor(runId))?.abort();
  }
  return { found: true, status: record.status };
}

// ============================================================
// Production executor + default deps
// ============================================================

/** Default executor: runs the requested backend's task runner, threading the cancel signal. */
export async function runAgentTaskDefault(
  input: AgentRunExecInput,
): Promise<AgentRunExecResult> {
  const runner = getTaskRunner(input.backend);
  try {
    const result = await runner.run({
      workingDirectory: input.workingDirectory,
      prompt: input.prompt,
      modelSelection: input.modelSelection,
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
      error: getErrorMessage(err),
      timedOut: false,
    };
  }
}

export function createDefaultAgentRunServiceDeps(input: {
  artifactRegistry?: ArtifactRegistry;
}): AgentRunServiceDeps {
  return {
    ensureDir: async (dirPath: string) => {
      await mkdir(dirPath, { recursive: true });
    },
    runTask: runAgentTaskDefault,
    ...(input.artifactRegistry !== undefined
      ? { artifactRegistry: input.artifactRegistry }
      : {}),
    newRunId: () => randomUUID(),
    now: () => new Date().toISOString(),
  };
}

/** Test isolation only — clears the shared abort registry. */
export function _resetForTesting(): void {
  _resetAbortRegistryForTesting();
}
