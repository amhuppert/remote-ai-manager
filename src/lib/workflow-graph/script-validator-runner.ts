import {
  mkdir as defaultMkdir,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  createArtifactRegistry,
  ArtifactRequiredFailure,
  type ArtifactRegistry,
} from "@/lib/workflows/primitives/artifact-registry";
import type { ScriptValidationOutcome } from "@/lib/workflows/primitives/script-validation-gate";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import { getErrorMessage } from "@/lib/shared/errors";
import { defaultGitClient } from "@/lib/git/client";
import { getValidationService } from "@/lib/validation/singleton";
import type {
  ValidationService,
  ValidationSubmission,
  ValidationSystemCommandRef,
} from "@/lib/validation/service";
import { waitForSystemValidationCompletion } from "@/lib/validation/service";
import type { ValidationRunResult } from "@/lib/validation/schemas";

const logger = createLogger("script-validator-runner");

const READINESS_ATTEMPTS = 3;
const readinessReportSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    warnings: z.array(z.string()).max(100),
    summary: z.string().trim().min(1),
  })
  .strict();

function readinessFailure(result: ValidationRunResult): string | null {
  if (result.kind !== "passed")
    return `Readiness command ended with ${result.kind}`;
  let value: unknown;
  try {
    value = JSON.parse(result.output);
  } catch {
    return "Readiness command must return a JSON report with status, warnings, and summary";
  }
  const report = readinessReportSchema.safeParse(value);
  if (!report.success)
    return `Invalid readiness report: ${report.error.message}`;
  if (report.data.status === "ready" && report.data.warnings.length === 0)
    return null;
  return [report.data.summary, ...report.data.warnings].join("\n");
}

export interface ScriptValidatorInput {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  executionId: string;
  contextId: string;
  /**
   * Branch this context's work will merge into, forwarded to the validation
   * script as `TARGET_BRANCH` so it scopes checks to the diff against that
   * base. Worktree-isolated contexts pass the session branch (their fan-in
   * target); solo contexts pass the session's own merge target.
   */
  targetBranch?: string;
  timeoutMs?: number;
  /** Ordered registered commands selected for this context. */
  commands: string[];
  purpose?: "infrastructure";
  /**
   * When supplied, the script validator runs against this resolved target's
   * worktree and branch instead of `input.worktreePath` / `input.branchName`.
   * Solo-eligible contexts leave this undefined, preserving the
   * pre-parallelization behavior of running directly inside the session
   * worktree.
   */
  executionTarget?: ExecutionTarget;
  signal?: AbortSignal;
}

/**
 * Identity of the tree a validation ran against. A gate that "passed" on a
 * tree that then changed before certification is undetectable without this;
 * null fields mean git state could not be resolved (best-effort).
 */
export interface ValidationTreeState {
  headSha: string | null;
  dirty: boolean | null;
}

/**
 * The shared script-validation gate vocabulary, narrowed to this runner's
 * guarantee: every failure it reports has a persisted log artifact, so
 * downstream remediation (the reopened graph task) can point the implementer
 * at the full output. Pass/fail outcomes additionally carry the validated
 * tree's identity and the resolved command, keying the result to
 * (tree SHA, command) for audits.
 */
export type ScriptValidatorOutcome =
  | (Exclude<ScriptValidationOutcome, { kind: "fail" }> & {
      treeState?: ValidationTreeState;
      command?: string | null;
      readinessBlock?: { commandName: string; attempts: number };
    })
  | (Extract<ScriptValidationOutcome, { kind: "fail" }> & {
      logFilePath: string;
      logRelativePath: string;
      runId?: string;
      treeState?: ValidationTreeState;
      command?: string | null;
    });

export interface ScriptValidatorDeps {
  validationService: Pick<
    ValidationService,
    "submitSystem" | "waitForCompletion" | "cancelSystemOwned"
  >;
  writeFile(filePath: string, contents: string): Promise<void>;
  mkdir(
    dirPath: string,
    opts: { recursive: true },
  ): Promise<string | undefined>;
  now(): Date;
  /**
   * Resolve the validated worktree's HEAD SHA and dirtiness. Best-effort:
   * null fields on any git failure — identity stamping must never fail the
   * validation itself.
   */
  resolveTreeState?(worktreePath: string): Promise<ValidationTreeState>;
  /**
   * Optional injected `ArtifactRegistry`. When omitted, an
   * `ArtifactRegistry` is constructed from `deps.writeFile`/`deps.mkdir` so the
   * production write path always goes through the shared
   * `validation_log` artifact flow while still honoring caller-supplied fs
   * adapters (used by unit tests).
   */
  artifactRegistry?: ArtifactRegistry;
}

async function defaultResolveTreeState(
  worktreePath: string,
): Promise<ValidationTreeState> {
  try {
    const head = await defaultGitClient.git(
      ["rev-parse", "HEAD"],
      worktreePath,
    );
    const status = await defaultGitClient.git(
      ["status", "--porcelain=v1"],
      worktreePath,
    );
    return {
      headSha: head.stdout.trim() || null,
      dirty: status.stdout.trim().length > 0,
    };
  } catch {
    return { headSha: null, dirty: null };
  }
}

const defaultDeps: ScriptValidatorDeps = {
  validationService: {
    submitSystem: (request) => getValidationService().submitSystem(request),
    waitForCompletion: (runId) =>
      getValidationService().waitForCompletion(runId),
    cancelSystemOwned: (runId) =>
      getValidationService().cancelSystemOwned(runId),
  },
  writeFile: async (filePath, contents) => {
    await defaultWriteFile(filePath, contents, "utf-8");
  },
  mkdir: (dirPath, opts) => defaultMkdir(dirPath, opts),
  now: () => new Date(),
  resolveTreeState: defaultResolveTreeState,
};

const LOG_DIR_SEGMENTS = [".cc", "workflow"] as const;

function formatTimestampForFilename(now: Date): string {
  const iso = now.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function buildLogFileHeader(
  input: ScriptValidatorInput,
  now: Date,
  branchName: string,
  beforeTreeState: ValidationTreeState,
  afterTreeState: ValidationTreeState,
  command: string,
  runId: string,
  result: ValidationRunResult,
): string {
  return [
    "# Validation command result",
    `timestamp: ${now.toISOString()}`,
    `execution: ${input.executionId}`,
    `context: ${input.contextId}`,
    `session: ${input.sessionName}`,
    `branch: ${branchName}`,
    `tree-before: ${beforeTreeState.headSha ?? "unknown"}${beforeTreeState.dirty === true ? " (dirty)" : ""}`,
    `tree-after: ${afterTreeState.headSha ?? "unknown"}${afterTreeState.dirty === true ? " (dirty)" : ""}`,
    `command: ${command}`,
    `run: ${runId}`,
    `outcome: ${result.kind}`,
    "",
  ].join("\n");
}

function outputFromResult(result: ValidationRunResult): string {
  if (
    result.kind === "passed" ||
    result.kind === "failed" ||
    result.kind === "timed_out"
  ) {
    return result.output.length > 0 ? result.output : "(no output captured)";
  }
  return "(no output captured)";
}

function unknownCommandOutcome(
  result: Extract<ValidationRunResult, { kind: "command_not_found" }>,
): ScriptValidatorOutcome {
  const known =
    result.knownCommands.length > 0
      ? result.knownCommands.join(", ")
      : "(none)";
  return {
    kind: "infra_error",
    reason: "unknown_command",
    commandName: result.name,
    message: `Script validator command "${result.name}" is not registered; registered commands: ${known}`,
  };
}

export function createScriptValidatorRunner(
  deps: ScriptValidatorDeps = defaultDeps,
) {
  async function runScriptValidator(
    input: ScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome> {
    const targetWorktreePath =
      input.executionTarget?.worktreePath ?? input.worktreePath;
    const targetBranchName =
      input.executionTarget?.branchName ?? input.branchName;

    const resolveTreeState = deps.resolveTreeState ?? defaultResolveTreeState;
    const commandRefs: ValidationSystemCommandRef[] = input.commands.map(
      (name) => ({
        kind: "registered",
        name,
      }),
    );

    let finalTreeState: ValidationTreeState | undefined;
    let finalCommand: string | null = null;
    for (const commandRef of commandRefs) {
      const maxAttempts =
        input.purpose === "infrastructure" ? READINESS_ATTEMPTS : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const beforeTreeState = await resolveTreeState(targetWorktreePath);
        let submission: ValidationSubmission;
        try {
          submission = await deps.validationService.submitSystem({
            source: "graph_script_validator",
            command: commandRef,
            scope: "changed",
            projectPath: input.projectPath,
            workflow: {
              executionId: input.executionId,
              contextId: input.contextId,
            },
            target: {
              worktreePath: targetWorktreePath,
              sessionName: input.sessionName,
              branchName: targetBranchName,
              ...(input.targetBranch
                ? { targetBranch: input.targetBranch }
                : {}),
              contextId: input.contextId,
            },
          });
        } catch (err) {
          const message = getErrorMessage(err);
          logger.error("script_validator.exception", {
            executionId: input.executionId,
            contextId: input.contextId,
            command: commandRef.name,
            error: message,
          });
          return { kind: "infra_error", reason: "exception", message };
        }

        if (submission.kind === "invalid") {
          return {
            kind: "infra_error",
            reason: "exception",
            message: submission.message,
          };
        }
        if (submission.kind === "not_started") {
          if (submission.result.kind === "command_not_found") {
            return unknownCommandOutcome(submission.result);
          }
          return {
            kind: "infra_error",
            reason: "exception",
            message:
              submission.result.kind === "cost_exceeds_limit"
                ? `Validation command "${commandRef.name}" costs ${submission.result.cost}, exceeding the configured limit ${submission.result.limit}`
                : `Validation command "${commandRef.name}" was not started (${submission.result.kind})`,
          };
        }

        const result = await waitForSystemValidationCompletion(
          deps.validationService,
          submission.runId,
          input.signal,
        );
        const afterTreeState = await resolveTreeState(targetWorktreePath);
        const now = deps.now();
        const relativeDir = path.join(...LOG_DIR_SEGMENTS, input.executionId);
        const fileName = `${commandRef.name}-${formatTimestampForFilename(now)}-${submission.runId}.log`;
        const logRelativePath = path.join(relativeDir, fileName);
        const logFilePath = path.join(targetWorktreePath, logRelativePath);
        const content = `${buildLogFileHeader(
          input,
          now,
          targetBranchName,
          beforeTreeState,
          afterTreeState,
          commandRef.name,
          submission.runId,
          result,
        )}\n${outputFromResult(result)}\n`;
        const registry =
          deps.artifactRegistry ??
          createArtifactRegistry({
            writeFile: async (absolutePath, fileContents) => {
              await deps.writeFile(
                absolutePath,
                typeof fileContents === "string"
                  ? fileContents
                  : Buffer.from(fileContents).toString("utf-8"),
              );
            },
            ensureDir: async (absolutePath) => {
              await deps.mkdir(absolutePath, { recursive: true });
            },
            now: () => now.toISOString(),
          });

        try {
          await registry.write({
            kind: "validation_log",
            worktreePath: targetWorktreePath,
            relativePath: logRelativePath,
            contents: content,
            audience: "internal_log",
            source: { workflowId: input.executionId },
          });
        } catch (err) {
          const cause =
            err instanceof ArtifactRequiredFailure ? (err.cause ?? err) : err;
          const message = getErrorMessage(cause);
          logger.error("script_validator.write_log_failed", {
            executionId: input.executionId,
            contextId: input.contextId,
            command: commandRef.name,
            runId: submission.runId,
            logFilePath,
            error: message,
          });
          return { kind: "infra_error", reason: "exception", message };
        }

        finalTreeState = afterTreeState;
        finalCommand = commandRef.name;
        if (input.purpose === "infrastructure") {
          const message = readinessFailure(result);
          if (message !== null) {
            logger.warn("script_validator.readiness_blocked", {
              executionId: input.executionId,
              contextId: input.contextId,
              command: commandRef.name,
              attempt,
              maxAttempts,
              runId: submission.runId,
              logFilePath,
              detail: message,
            });
            if (
              attempt < maxAttempts &&
              !input.signal?.aborted &&
              result.kind !== "cancelled"
            )
              continue;
            return {
              kind: "infra_error",
              reason: "exception",
              message,
              readinessBlock: {
                commandName: commandRef.name,
                attempts: attempt,
              },
            };
          }
        }
        if (result.kind === "passed") {
          logger.info("script_validator.command_passed", {
            executionId: input.executionId,
            contextId: input.contextId,
            command: commandRef.name,
            runId: submission.runId,
            headSha: afterTreeState.headSha,
            dirty: afterTreeState.dirty,
            logFilePath,
          });
          break;
        }
        if (result.kind === "failed" && result.exitCode === null) {
          const detail = result.output.trim();
          const message = `Validation command "${commandRef.name}" could not be spawned${detail.length > 0 ? `: ${detail}` : ""}`;
          logger.error("script_validator.command_spawn_failed", {
            executionId: input.executionId,
            contextId: input.contextId,
            command: commandRef.name,
            runId: submission.runId,
            logFilePath,
            error: detail,
          });
          return { kind: "infra_error", reason: "exception", message };
        }
        if (result.kind === "failed" || result.kind === "timed_out") {
          const timedOut = result.kind === "timed_out";
          logger.warn("script_validator.command_failed", {
            executionId: input.executionId,
            contextId: input.contextId,
            command: commandRef.name,
            runId: submission.runId,
            timedOut,
            logFilePath,
          });
          return {
            kind: "fail",
            summary: timedOut
              ? `Validation command "${commandRef.name}" timed out`
              : `Validation command "${commandRef.name}" failed`,
            logFilePath,
            logRelativePath,
            timedOut,
            runId: submission.runId,
            treeState: afterTreeState,
            command: commandRef.name,
          };
        }
        return {
          kind: "infra_error",
          reason: "exception",
          message: `Validation command "${commandRef.name}" ended with ${result.kind}`,
        };
      }
    }

    logger.info("script_validator.pass", {
      executionId: input.executionId,
      contextId: input.contextId,
      commandCount: commandRefs.length,
      headSha: finalTreeState?.headSha ?? null,
      dirty: finalTreeState?.dirty ?? null,
    });
    return {
      kind: "pass",
      ...(finalTreeState ? { treeState: finalTreeState } : {}),
      command: finalCommand,
    };
  }

  return { runScriptValidator };
}
