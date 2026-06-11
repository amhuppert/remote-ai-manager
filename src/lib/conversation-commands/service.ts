import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/lib/sessions/schemas";
import { getSession } from "@/lib/state-store";
import { getJob, dispatchCommitJob, dispatchMergeJob } from "@/lib/jobs/queue";
import { hasUncommittedChanges, collectChangeSummary } from "@/lib/git/commits";
import { resolveMergeTarget, type MergeTarget } from "@/lib/git/merge-target";
import { executeWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { appendNotice, type AppendNoticeInput } from "@/lib/prompt/transcript";
import {
  buildGenerationPrompt,
  defaultMessage,
  resolveGeneratedMessage,
  type GenerationContext,
} from "./generation";
import { COMMIT_MESSAGE_JSON_SCHEMA } from "./schemas";
import type { ParsedConversationCommand } from "./schemas";

const logger = createLogger("conversation-commands");

/** Upper bound for the message-generation turn — the agent only writes prose. */
const GENERATION_TIMEOUT_MS = 180_000;

export type JobDispatchError = "SESSION_BUSY" | "JOB_ALREADY_RUNNING";

export type DispatchResult =
  | { ok: true; value: { jobId: string } }
  | { ok: false; error: JobDispatchError };

export interface DispatchCommitParams {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  targetBranch?: string;
}

export interface DispatchMergeParams {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  autoResolve: boolean;
  targetBranch?: string;
  targetWorktreePath?: string;
}

export interface ConversationCommandDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  hasActiveJob(projectPath: string, sessionName: string): boolean;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  collectChangeSummary(worktreePath: string): Promise<string>;
  resolveMergeTarget(
    projectPath: string,
    session: SessionState,
  ): Promise<MergeTarget>;
  executeWorkflowTaskRun(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
  dispatchCommitJob(params: DispatchCommitParams): DispatchResult;
  dispatchMergeJob(params: DispatchMergeParams): DispatchResult;
  appendNotice(input: AppendNoticeInput): Promise<void>;
}

export interface RunCommandInput {
  projectPath: string;
  projectName: string;
  /** null → the conversation has no associated session worktree (1.5). */
  sessionName: string | null;
  /**
   * SSE scope address for notices when `sessionName` is null. Project
   * conversations pass the project sentinel here so the rejection-notice
   * broadcast carries `scope: "project"` and reaches project-scoped clients
   * (see `conversationEventScopeFields`).
   */
  noticeSessionName?: string;
  conversationId: string;
  parsed: ParsedConversationCommand;
}

export type RejectionReason =
  | "no-session"
  | "session-finished"
  | "job-active"
  | "no-changes"
  | "dispatch-failed";

export type RunCommandOutcome =
  | { status: "dispatched"; jobId: string; usedFallback: boolean }
  | { status: "rejected"; reason: RejectionReason };

const REJECTION_NOTICES: Record<
  Exclude<RejectionReason, "dispatch-failed">,
  (command: ParsedConversationCommand["command"]) => string
> = {
  "no-session": (command) =>
    `Cannot run /${command}: this conversation has no session worktree.`,
  "session-finished": (command) =>
    `Cannot run /${command}: the session is finished.`,
  "job-active": (command) =>
    `Cannot run /${command}: a commit, merge, or conflict-resolution job is already running for this session.`,
  "no-changes": (command) =>
    `Cannot run /${command}: the session worktree has no uncommitted changes.`,
};

export function createConversationCommandService(
  deps: ConversationCommandDeps,
) {
  async function reject(
    input: RunCommandInput,
    reason: Exclude<RejectionReason, "dispatch-failed">,
  ): Promise<RunCommandOutcome> {
    logger.info("command.rejected", {
      command: input.parsed.command,
      reason,
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    });
    await deps.appendNotice({
      conversationId: input.conversationId,
      text: REJECTION_NOTICES[reason](input.parsed.command),
      projectName: input.projectName,
      sessionName: input.sessionName ?? input.noticeSessionName ?? "",
    });
    return { status: "rejected", reason };
  }

  async function checkEligibility(
    input: RunCommandInput,
  ): Promise<
    | { eligible: true; session: SessionState }
    | { eligible: false; outcome: RunCommandOutcome }
  > {
    if (input.sessionName === null) {
      return { eligible: false, outcome: await reject(input, "no-session") };
    }

    const session = await deps.getSession(input.projectPath, input.sessionName);
    if (session === null) {
      return { eligible: false, outcome: await reject(input, "no-session") };
    }

    if (session.finished) {
      return {
        eligible: false,
        outcome: await reject(input, "session-finished"),
      };
    }

    if (deps.hasActiveJob(input.projectPath, input.sessionName)) {
      return { eligible: false, outcome: await reject(input, "job-active") };
    }

    if (
      input.parsed.command === "commit" &&
      !(await deps.hasUncommittedChanges(session.worktreePath))
    ) {
      return { eligible: false, outcome: await reject(input, "no-changes") };
    }

    return { eligible: true, session };
  }

  async function engageFallback(
    input: RunCommandInput,
    ctx: GenerationContext,
    reason: string,
    generationDurationMs: number | null,
  ): Promise<{ message: string; usedFallback: true }> {
    const fallback = defaultMessage(ctx);
    logger.warn("command.generation_fallback", {
      command: ctx.command,
      reason,
      fallbackMessage: fallback,
      generationDurationMs,
      conversationId: input.conversationId,
    });
    await deps.appendNotice({
      conversationId: input.conversationId,
      text: `Commit message generation failed (${reason}); proceeding with the default message: "${fallback}".`,
      projectName: input.projectName,
      sessionName: ctx.sessionName,
    });
    return { message: fallback, usedFallback: true };
  }

  async function generateMessage(
    input: RunCommandInput,
    ctx: GenerationContext,
  ): Promise<{ message: string; usedFallback: boolean }> {
    const startedAt = performance.now();
    let resolved: ReturnType<typeof resolveGeneratedMessage>;
    try {
      const result = await deps.executeWorkflowTaskRun({
        projectPath: input.projectPath,
        sessionName: ctx.sessionName,
        conversationId: input.conversationId,
        kind: "task_run",
        prompt: buildGenerationPrompt(ctx),
        outputFormat: {
          type: "json_schema",
          schema: COMMIT_MESSAGE_JSON_SCHEMA,
        },
        timeoutMs: GENERATION_TIMEOUT_MS,
      });
      logger.info("command.generation_complete", {
        command: ctx.command,
        resultKind: result.kind,
        durationMs: Math.round(performance.now() - startedAt),
        conversationId: input.conversationId,
      });
      resolved = resolveGeneratedMessage(result);
    } catch (err) {
      resolved = {
        ok: false,
        reason: `generation turn threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (resolved.ok) {
      return { message: resolved.message, usedFallback: false };
    }

    return engageFallback(
      input,
      ctx,
      resolved.reason,
      Math.round(performance.now() - startedAt),
    );
  }

  async function executeEligibleCommand(
    input: RunCommandInput,
    session: SessionState,
  ): Promise<RunCommandOutcome> {
    const { parsed } = input;

    let target: MergeTarget | null = null;
    if (parsed.command === "merge") {
      try {
        target = await deps.resolveMergeTarget(input.projectPath, session);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("command.merge_target_failed", {
          command: parsed.command,
          reason,
          sessionName: session.sessionName,
          conversationId: input.conversationId,
        });
        await deps.appendNotice({
          conversationId: input.conversationId,
          text: `Cannot run /merge: failed to resolve the merge target (${reason}).`,
          projectName: input.projectName,
          sessionName: session.sessionName,
        });
        return { status: "rejected", reason: "dispatch-failed" };
      }
    }

    let changeSummary:
      | { ok: true; value: string }
      | { ok: false; reason: string };
    try {
      changeSummary = {
        ok: true,
        value: await deps.collectChangeSummary(session.worktreePath),
      };
    } catch (err) {
      changeSummary = {
        ok: false,
        reason: `change summary collection failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const ctx: GenerationContext = {
      command: parsed.command,
      hint: parsed.hint,
      sessionName: session.sessionName,
      branchName: session.branchName,
      targetBranch: target?.targetBranch ?? null,
      changeSummary: changeSummary.ok ? changeSummary.value : "",
    };

    const { message, usedFallback } = changeSummary.ok
      ? await generateMessage(input, ctx)
      : await engageFallback(input, ctx, changeSummary.reason, null);

    const dispatched =
      parsed.command === "merge"
        ? deps.dispatchMergeJob({
            projectPath: input.projectPath,
            projectName: input.projectName,
            sessionName: session.sessionName,
            worktreePath: session.worktreePath,
            branchName: session.branchName,
            message,
            autoResolve: true,
            targetBranch: target?.targetBranch,
            targetWorktreePath: target?.targetWorktreePath ?? undefined,
          })
        : deps.dispatchCommitJob({
            projectPath: input.projectPath,
            projectName: input.projectName,
            sessionName: session.sessionName,
            worktreePath: session.worktreePath,
            branchName: session.branchName,
            message,
            targetBranch: session.targetBranch,
          });

    if (!dispatched.ok) {
      logger.warn("command.dispatch_failed", {
        command: parsed.command,
        error: dispatched.error,
        sessionName: session.sessionName,
        conversationId: input.conversationId,
      });
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `Cannot run /${parsed.command}: ${
          dispatched.error === "SESSION_BUSY"
            ? "the session is busy"
            : "a background job is already running for this session"
        }.`,
        projectName: input.projectName,
        sessionName: session.sessionName,
      });
      return { status: "rejected", reason: "dispatch-failed" };
    }

    logger.info("command.dispatched", {
      command: parsed.command,
      jobId: dispatched.value.jobId,
      usedFallback,
      sessionName: session.sessionName,
      conversationId: input.conversationId,
    });
    return {
      status: "dispatched",
      jobId: dispatched.value.jobId,
      usedFallback,
    };
  }

  async function run(input: RunCommandInput): Promise<RunCommandOutcome> {
    const eligibility = await checkEligibility(input);
    if (!eligibility.eligible) return eligibility.outcome;
    return executeEligibleCommand(input, eligibility.session);
  }

  return { run };
}

export type ConversationCommandService = ReturnType<
  typeof createConversationCommandService
>;

const productionDeps: ConversationCommandDeps = {
  getSession(projectPath, sessionName) {
    return getSession(projectPath, sessionName);
  },
  hasActiveJob(projectPath, sessionName) {
    return getJob(projectPath, sessionName)?.status === "running";
  },
  hasUncommittedChanges,
  collectChangeSummary,
  resolveMergeTarget,
  executeWorkflowTaskRun,
  dispatchCommitJob,
  dispatchMergeJob,
  appendNotice,
};

export const conversationCommandService =
  createConversationCommandService(productionDeps);
