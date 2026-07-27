import { createLogger } from "@/lib/logging";
import {
  isWorkflowLaneRole,
  type ConversationRole,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  getConversation,
  getProjectConversation,
  getSession,
} from "@/lib/state-store";
import {
  getJob,
  dispatchCommitJob,
  dispatchMergeJob,
  dispatchRebaseJob,
} from "@/lib/jobs/queue";
import { hasUncommittedChanges, collectChangeSummary } from "@/lib/git/commits";
import { resolveMergeTarget, type MergeTarget } from "@/lib/git/merge-target";
import type { RebaseOnto } from "@/lib/git/rebase";
import { parseRebaseArgs } from "./rebase-args";
import { executeWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import { appendNotice, type AppendNoticeInput } from "@/lib/prompt/transcript";
import { AlignmentNotSupportedError } from "@/lib/session-alignment/service";
import { createSessionAlignmentServiceForProduction } from "@/lib/session-alignment/service-factory";
import type {
  TicketCommandInput,
  TicketCommandOutcome,
} from "@/lib/tickets/slash-command";
import { enqueueConversationMessage } from "@/lib/prompt/enqueue-conversation-message";
import {
  buildGenerationPrompt,
  defaultMessage,
  resolveGeneratedMessage,
  type GenerationContext,
} from "./generation";
import {
  COMMIT_MESSAGE_JSON_SCHEMA,
  MERGE_MESSAGE_JSON_SCHEMA,
} from "./schemas";
import type { ParsedConversationCommand } from "./schemas";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conversation-commands");

/** Upper bound for the message-generation turn — the agent only writes prose. */
const GENERATION_TIMEOUT_MS = 180_000;

export type JobDispatchError = "SESSION_BUSY" | "JOB_ALREADY_RUNNING";

export type DispatchResult =
  | { ok: true; value: { jobId: string } }
  | { ok: false; error: JobDispatchError };

/**
 * Merge dispatch can additionally refuse with a structured merge-association
 * refusal (reason + instruction) when the session hosts spec-execution state
 * the delivery gate could not evaluate from this merge.
 */
export type MergeCommandDispatchResult =
  | { ok: true; value: { jobId: string } }
  | {
      ok: false;
      error:
        | JobDispatchError
        | {
            code: "MERGE_ASSOCIATION_REFUSED";
            reason: string;
            instruction: string;
          };
    };

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
  /** Agent-written intent notes for a later conflict-resolution turn. */
  resolutionContext?: string;
}

export interface DispatchRebaseParams {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  /** Where to replay the session's commits onto. */
  onto: RebaseOnto;
  /** Human label for the target (`main` / `origin/main`), shown in notices. */
  targetLabel: string;
  conversationId?: string;
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
  dispatchMergeJob(params: DispatchMergeParams): MergeCommandDispatchResult;
  dispatchRebaseJob(params: DispatchRebaseParams): DispatchResult;
  appendNotice(input: AppendNoticeInput): Promise<void>;
  /**
   * Begin (or redraft) the session's Alignment charter and return the agent
   * authoring prompt to enqueue. Throws `AlignmentNotSupportedError` when the
   * session does not support alignment (e.g. optimistic mode).
   */
  beginAlignmentDraft(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    /** Free-text guidance the user typed after `/align` (empty string if none). */
    guidance: string;
  }): Promise<{ authoringPrompt: string; draftId: string }>;
  /** Enqueue the alignment authoring turn into the originating conversation. */
  enqueueAuthoringTurn(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    message: string;
  }): Promise<void>;
  /**
   * Server-owned `/ticket` creation: structured task-run turn, compaction
   * snapshot, and create+attach in one transaction, with its own success and
   * failure notices (see `@/lib/tickets/slash-command`).
   */
  runTicketCommand(input: TicketCommandInput): Promise<TicketCommandOutcome>;
  /**
   * Workflow role of the conversation (`null` for user conversations and when
   * the conversation cannot be found — the ticket runner reports not-found).
   */
  getConversationRole(
    projectPath: string,
    sessionName: string | null,
    conversationId: string,
  ): Promise<ConversationRole>;
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
  | "alignment-unavailable"
  | "workflow-lane"
  | "dispatch-failed";

export type RunCommandOutcome =
  | { status: "dispatched"; jobId: string; usedFallback: boolean }
  | { status: "alignment_draft_started"; draftId: string }
  | {
      status: "ticket_created";
      identifier: string;
      confirmationPersisted: boolean;
    }
  | {
      status: "ticket_failed";
      reason: string;
      failureNoticePersisted: boolean;
    }
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
  "alignment-unavailable": () =>
    "Cannot run /align: alignment is unavailable for this session.",
  "workflow-lane": (command) =>
    `Cannot run /${command}: this conversation is managed by a graph workflow.`,
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
      storeSessionName: input.sessionName ?? input.noticeSessionName ?? "",
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
  ): Promise<{
    message: string;
    resolutionContext?: string;
    usedFallback: true;
  }> {
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
      storeSessionName: ctx.sessionName,
    });
    return { message: fallback, usedFallback: true };
  }

  async function generateMessage(
    input: RunCommandInput,
    ctx: GenerationContext,
  ): Promise<{
    message: string;
    resolutionContext?: string;
    usedFallback: boolean;
  }> {
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
          schema:
            ctx.command === "merge"
              ? MERGE_MESSAGE_JSON_SCHEMA
              : COMMIT_MESSAGE_JSON_SCHEMA,
        },
        structuredOutputTextField: "message",
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
        reason: `generation turn threw: ${getErrorMessage(err)}`,
      };
    }

    if (resolved.ok) {
      return {
        message: resolved.message,
        resolutionContext: resolved.resolutionContext,
        usedFallback: false,
      };
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

    // align, ticket, and rebase are routed before this point; this guard
    // narrows the remaining flow to the message-generating git-job commands.
    if (
      parsed.command === "align" ||
      parsed.command === "ticket" ||
      parsed.command === "rebase"
    ) {
      throw new Error(
        `${parsed.command} must be routed by run(), not the message-gen git-job path`,
      );
    }

    let target: MergeTarget | null = null;
    if (parsed.command === "merge") {
      try {
        target = await deps.resolveMergeTarget(input.projectPath, session);
      } catch (err) {
        const reason = getErrorMessage(err);
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
          storeSessionName: session.sessionName,
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
        reason: `change summary collection failed: ${getErrorMessage(err)}`,
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

    const { message, resolutionContext, usedFallback } = changeSummary.ok
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
            resolutionContext,
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
      const dispatchErrorText =
        typeof dispatched.error === "string"
          ? `${
              dispatched.error === "SESSION_BUSY"
                ? "the session is busy"
                : "a background job is already running for this session"
            }.`
          : `${dispatched.error.reason} ${dispatched.error.instruction}`;
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `Cannot run /${parsed.command}: ${dispatchErrorText}`,
        projectName: input.projectName,
        storeSessionName: session.sessionName,
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

  /**
   * `/rebase` replays the session branch onto another branch, reusing the
   * automatic conflict resolver. Unlike `/commit` and `/merge` it generates no
   * message (it replays existing commits) and never touches the target branch,
   * so it dispatches straight to the rebase job after parsing its target from
   * the hint (`""` → session target, `main` → local, `origin main` → remote).
   * The clean-worktree precondition is owned by the rebase machine, so every
   * dispatch path is guarded uniformly.
   */
  async function runRebase(
    input: RunCommandInput,
    session: SessionState,
  ): Promise<RunCommandOutcome> {
    const parsedArgs = parseRebaseArgs(input.parsed.hint, session.targetBranch);
    if (!parsedArgs.ok) {
      logger.warn("command.rebase_args_invalid", {
        reason: parsedArgs.error,
        sessionName: session.sessionName,
        conversationId: input.conversationId,
      });
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `Cannot run /rebase: ${parsedArgs.error}`,
        projectName: input.projectName,
        storeSessionName: session.sessionName,
      });
      return { status: "rejected", reason: "dispatch-failed" };
    }

    const dispatched = deps.dispatchRebaseJob({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: session.sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      onto: parsedArgs.onto,
      targetLabel: parsedArgs.label,
      conversationId: input.conversationId,
    });

    if (!dispatched.ok) {
      logger.warn("command.dispatch_failed", {
        command: "rebase",
        error: dispatched.error,
        sessionName: session.sessionName,
        conversationId: input.conversationId,
      });
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `Cannot run /rebase: ${
          dispatched.error === "SESSION_BUSY"
            ? "the session is busy"
            : "a background job is already running for this session"
        }.`,
        projectName: input.projectName,
        storeSessionName: session.sessionName,
      });
      return { status: "rejected", reason: "dispatch-failed" };
    }

    logger.info("command.dispatched", {
      command: "rebase",
      jobId: dispatched.value.jobId,
      targetLabel: parsedArgs.label,
      sessionName: session.sessionName,
      conversationId: input.conversationId,
    });
    return {
      status: "dispatched",
      jobId: dispatched.value.jobId,
      usedFallback: false,
    };
  }

  /**
   * The `/align` path is separate from the commit/merge git-job machinery: it
   * begins (or redrafts) the session's Alignment charter and enqueues an agent
   * authoring turn. It is available at any lifecycle point and does not gate on
   * job-active or uncommitted changes (R2.2), nor does it archive the
   * conversation.
   *
   * Conflict resolution: tasks.md says `/align` is accepted regardless of
   * creation mode, but the alignment service enforces normal-only (R12.2). The
   * command is recognized/routed for any session; the service throws
   * `AlignmentNotSupportedError` for optimistic/unsupported sessions, which we
   * surface as a graceful rejection rather than a crash.
   */
  async function runAlign(input: RunCommandInput): Promise<RunCommandOutcome> {
    if (input.sessionName === null) {
      return reject(input, "no-session");
    }
    const session = await deps.getSession(input.projectPath, input.sessionName);
    if (session === null) {
      return reject(input, "no-session");
    }
    if (session.finished) {
      return reject(input, "session-finished");
    }

    let draft: { authoringPrompt: string; draftId: string };
    try {
      draft = await deps.beginAlignmentDraft({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        guidance: input.parsed.hint,
      });
    } catch (err) {
      if (err instanceof AlignmentNotSupportedError) {
        logger.info("align.unavailable", {
          projectName: input.projectName,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          reason: err.message,
        });
        return reject(input, "alignment-unavailable");
      }
      throw err;
    }

    await deps.enqueueAuthoringTurn({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      message: draft.authoringPrompt,
    });

    logger.info("align.draft_started", {
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      draftId: draft.draftId,
    });

    return { status: "alignment_draft_started", draftId: draft.draftId };
  }

  /**
   * `/ticket` is separate from the commit/merge git-job machinery: project
   * conversations are eligible (the ticket lands in the conversation's
   * project), and the job-active / uncommitted-changes gates do not apply.
   * Session conversations still require a live session for the task-run turn,
   * reusing the existing rejection notices. Graph-workflow lane conversations
   * (implementer/validator) DO reach this path — an open approval gate admits
   * lane prompts to the prompt route — so they are rejected here before any
   * ticket work starts.
   */
  async function runTicket(input: RunCommandInput): Promise<RunCommandOutcome> {
    const role = await deps.getConversationRole(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    if (isWorkflowLaneRole(role)) {
      return reject(input, "workflow-lane");
    }

    if (input.sessionName !== null) {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (session === null) {
        return reject(input, "no-session");
      }
      if (session.finished) {
        return reject(input, "session-finished");
      }
    }

    const outcome = await deps.runTicketCommand({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      hint: input.parsed.hint,
    });

    logger.info("command.ticket_complete", {
      status: outcome.status,
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    });

    return outcome.status === "created"
      ? {
          status: "ticket_created",
          identifier: outcome.identifier,
          confirmationPersisted: outcome.confirmationPersisted,
        }
      : {
          status: "ticket_failed",
          reason: outcome.reason,
          failureNoticePersisted: outcome.failureNoticePersisted,
        };
  }

  async function run(input: RunCommandInput): Promise<RunCommandOutcome> {
    if (input.parsed.command === "align") return runAlign(input);
    if (input.parsed.command === "ticket") return runTicket(input);

    const eligibility = await checkEligibility(input);
    if (!eligibility.eligible) return eligibility.outcome;
    if (input.parsed.command === "rebase") {
      return runRebase(input, eligibility.session);
    }
    return executeEligibleCommand(input, eligibility.session);
  }

  return { run };
}

export type ConversationCommandService = ReturnType<
  typeof createConversationCommandService
>;

// Memoized so importing this module never opens the DB; the alignment service
// is built lazily on first `/align`.
let alignmentService: ReturnType<
  typeof createSessionAlignmentServiceForProduction
> | null = null;

function getAlignmentService() {
  alignmentService ??= createSessionAlignmentServiceForProduction();
  return alignmentService;
}

const productionDeps: ConversationCommandDeps = {
  getSession(projectPath, sessionName) {
    return getSession(projectPath, sessionName);
  },
  async getConversationRole(projectPath, sessionName, conversationId) {
    const conversation =
      sessionName === null
        ? await getProjectConversation(projectPath, conversationId)
        : await getConversation(projectPath, sessionName, conversationId);
    return conversation?.role ?? null;
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
  dispatchRebaseJob,
  appendNotice,
  beginAlignmentDraft(input) {
    return getAlignmentService().beginDraft({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      guidance: input.guidance,
    });
  },
  enqueueAuthoringTurn: enqueueConversationMessage,
  // Dynamic so the tickets/compaction graph stays off this module's static
  // import graph (mirrors the dispatch.ts isolation rationale).
  async runTicketCommand(input) {
    const { getTicketCommandRunner } =
      await import("@/lib/tickets/service-factory");
    return getTicketCommandRunner().run(input);
  },
};

export const conversationCommandService =
  createConversationCommandService(productionDeps);
