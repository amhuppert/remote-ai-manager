import {
  mkdir as defaultMkdir,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import {
  executeRepoValidationCommand as defaultExecuteRepoValidationCommand,
  type RepoValidationCommandResult,
} from "@/lib/repo-config";
import {
  createArtifactRegistry,
  ArtifactRequiredFailure,
  type ArtifactRegistry,
} from "@/lib/workflows/primitives/artifact-registry";

const logger = createLogger("script-validator-runner");

export interface ScriptValidatorInput {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  executionId: string;
  contextId: string;
  timeoutMs?: number;
}

export type ScriptValidatorOutcome =
  | { kind: "pass" }
  | {
      kind: "fail";
      summary: string;
      logFilePath: string;
      logRelativePath: string;
      timedOut: boolean;
    }
  | {
      kind: "infra_error";
      reason: "missing_pre_merge_command" | "exception";
      message: string;
    };

export interface ScriptValidatorDeps {
  executeRepoValidationCommand(params: {
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    timeoutMs?: number;
  }): Promise<RepoValidationCommandResult>;
  writeFile(filePath: string, contents: string): Promise<void>;
  mkdir(
    dirPath: string,
    opts: { recursive: true },
  ): Promise<string | undefined>;
  now(): Date;
  /**
   * Optional injected `ArtifactRegistry`. When omitted, an
   * `ArtifactRegistry` is constructed from `deps.writeFile`/`deps.mkdir` so the
   * production write path always goes through the shared
   * `validation_log` artifact flow while still honoring caller-supplied fs
   * adapters (used by unit tests).
   */
  artifactRegistry?: ArtifactRegistry;
}

const defaultDeps: ScriptValidatorDeps = {
  executeRepoValidationCommand: defaultExecuteRepoValidationCommand,
  writeFile: async (filePath, contents) => {
    await defaultWriteFile(filePath, contents, "utf-8");
  },
  mkdir: (dirPath, opts) => defaultMkdir(dirPath, opts),
  now: () => new Date(),
};

const LOG_DIR_SEGMENTS = [".cc", "workflow"] as const;

function formatTimestampForFilename(now: Date): string {
  const iso = now.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function buildLogFileHeader(input: ScriptValidatorInput, now: Date): string {
  return [
    "# Pre-merge validation failure",
    `timestamp: ${now.toISOString()}`,
    `execution: ${input.executionId}`,
    `context: ${input.contextId}`,
    `session: ${input.sessionName}`,
    `branch: ${input.branchName}`,
    "",
  ].join("\n");
}

export function createScriptValidatorRunner(
  deps: ScriptValidatorDeps = defaultDeps,
) {
  async function runScriptValidator(
    input: ScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome> {
    let result: RepoValidationCommandResult;
    try {
      result = await deps.executeRepoValidationCommand({
        projectPath: input.projectPath,
        worktreePath: input.worktreePath,
        sessionName: input.sessionName,
        branchName: input.branchName,
        timeoutMs: input.timeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      });
      return { kind: "pass" };
    }

    const now = deps.now();
    const relativeDir = path.join(...LOG_DIR_SEGMENTS, input.executionId);
    const fileName = `pre-merge-${formatTimestampForFilename(now)}.log`;
    const logRelativePath = path.join(relativeDir, fileName);
    const logFilePath = path.join(input.worktreePath, logRelativePath);

    const header = buildLogFileHeader(input, now);
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
        worktreePath: input.worktreePath,
        relativePath: logRelativePath,
        contents: content,
        audience: "internal_log",
        required: true,
        source: { workflowId: input.executionId },
      });
    } catch (err) {
      const cause =
        err instanceof ArtifactRequiredFailure ? (err.cause ?? err) : err;
      const message = cause instanceof Error ? cause.message : String(cause);
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
    };
  }

  return { runScriptValidator };
}

export type ScriptValidatorRunner = ReturnType<
  typeof createScriptValidatorRunner
>;
