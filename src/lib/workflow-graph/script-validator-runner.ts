import {
  mkdir as defaultMkdir,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import {
  executeRepoValidationCommand as defaultExecuteRepoValidationCommand,
  type RepoValidationCommandResult,
} from "@/lib/projects/repo-config";
import {
  createArtifactRegistry,
  ArtifactRequiredFailure,
  type ArtifactRegistry,
} from "@/lib/workflows/primitives/artifact-registry";
import type { ScriptValidationOutcome } from "@/lib/workflows/primitives/script-validation-gate";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import { getErrorMessage } from "@/lib/shared/errors";
import { defaultGitClient } from "@/lib/git/client";

const logger = createLogger("script-validator-runner");

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
  /**
   * When supplied, the script validator runs against this resolved target's
   * worktree and branch instead of `input.worktreePath` / `input.branchName`.
   * Solo-eligible contexts leave this undefined, preserving the
   * pre-parallelization behavior of running directly inside the session
   * worktree.
   */
  executionTarget?: ExecutionTarget;
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
    })
  | (Extract<ScriptValidationOutcome, { kind: "fail" }> & {
      logFilePath: string;
      logRelativePath: string;
      treeState?: ValidationTreeState;
      command?: string | null;
    });

export interface ScriptValidatorDeps {
  executeRepoValidationCommand(params: {
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    targetBranch?: string;
    timeoutMs?: number;
  }): Promise<RepoValidationCommandResult>;
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
  executeRepoValidationCommand: defaultExecuteRepoValidationCommand,
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
  treeState: ValidationTreeState,
  command: string | null,
): string {
  return [
    "# Pre-merge validation failure",
    `timestamp: ${now.toISOString()}`,
    `execution: ${input.executionId}`,
    `context: ${input.contextId}`,
    `session: ${input.sessionName}`,
    `branch: ${branchName}`,
    `tree: ${treeState.headSha ?? "unknown"}${treeState.dirty === true ? " (dirty)" : ""}`,
    `command: ${command ?? "unknown"}`,
    "",
  ].join("\n");
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

    // Resolved before the command runs: this identifies the tree the result
    // certifies, even if the command itself mutates build artifacts.
    const resolveTreeState = deps.resolveTreeState ?? defaultResolveTreeState;
    const treeState = await resolveTreeState(targetWorktreePath);

    let result: RepoValidationCommandResult;
    try {
      result = await deps.executeRepoValidationCommand({
        projectPath: input.projectPath,
        worktreePath: targetWorktreePath,
        sessionName: input.sessionName,
        branchName: targetBranchName,
        targetBranch: input.targetBranch,
        timeoutMs: input.timeoutMs,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error("script_validator.exception", {
        executionId: input.executionId,
        contextId: input.contextId,
        error: message,
      });
      return { kind: "infra_error", reason: "exception", message };
    }

    if (!result.executed) {
      logger.warn("script_validator.missing_pre_merge_command", {
        executionId: input.executionId,
        contextId: input.contextId,
      });
      return {
        kind: "infra_error",
        reason: "missing_pre_merge_command",
        message:
          "Script validator enabled but the project has no preMergeCommand configured",
      };
    }

    if (result.pass) {
      logger.info("script_validator.pass", {
        executionId: input.executionId,
        contextId: input.contextId,
        headSha: treeState.headSha,
        dirty: treeState.dirty,
      });
      return { kind: "pass", treeState, command: result.command ?? null };
    }

    const now = deps.now();
    const relativeDir = path.join(...LOG_DIR_SEGMENTS, input.executionId);
    const fileName = `pre-merge-${formatTimestampForFilename(now)}.log`;
    const logRelativePath = path.join(relativeDir, fileName);
    const logFilePath = path.join(targetWorktreePath, logRelativePath);

    const header = buildLogFileHeader(
      input,
      now,
      targetBranchName,
      treeState,
      result.command ?? null,
    );
    const body =
      result.output.length > 0 ? result.output : "(no output captured)";
    const content = `${header}\n${body}\n`;

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
        logFilePath,
        error: message,
      });
      return { kind: "infra_error", reason: "exception", message };
    }

    logger.warn("script_validator.fail", {
      executionId: input.executionId,
      contextId: input.contextId,
      timedOut: result.timedOut,
      logFilePath,
    });

    return {
      kind: "fail",
      summary: result.message ?? "Pre-merge validation failed",
      logFilePath,
      logRelativePath,
      timedOut: result.timedOut,
      treeState,
      command: result.command ?? null,
    };
  }

  return { runScriptValidator };
}
