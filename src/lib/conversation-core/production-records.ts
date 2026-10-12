import { recordSeenAlignmentVersion } from "@/lib/conversation-core/contributions/alignment-gate";
import { dispatchPushForConversationStatus } from "@/lib/push-notification/dispatcher";
import {
  projectConversationTarget,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
import {
  messageQueueService,
  type MessageQueueService,
} from "@/lib/conversations/message-queue-service";
import { queueContentOfTurnInput } from "@/lib/conversations/queue-content";
import {
  conversationEventScopeFields,
  isProjectSentinel,
} from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import { publishEvent } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { appendNotice, getTranscriptPath } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import { admitConversationProfileForTurn } from "@/lib/conversations/profile-admission";
import { notifyProjectConversationStatusFromContext } from "@/lib/project-conversations/status-notifications";
import { getConversation, mutateConversation } from "@/lib/state-store";
import {
  createConversationsRepo,
  type ConversationsRepo,
} from "@/lib/state-store/conversations-repo";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "@/lib/state-store/project-conversations-repo";
import type { Db } from "@/lib/state-store/schemas";
import { getStateDb, type StateStore } from "@/lib/state-store/store";
import {
  applyBackendAdoption,
  applyClaimEnded,
  applyCustodyRow,
  applyLiveInputAccepted,
  applySegmentUsage,
  applyDebugCommandToRow,
  applyQuestionAsked,
  applyQuestionCleared,
  applyQuestionWithdrawn,
  applyTurnBegin,
  backendLocked,
  applyTurnClaimed,
  applyTurnInterrupted,
  applyTurnSettlement,
  statusWithoutQuestion,
  type ConversationIdentity,
  type ConversationRecordPort,
  type CustodyRecordPort,
  type LiveInputRecordPort,
  type QuestionBatch,
} from "./conversation-record";
import type { CoreDebugModeDeps } from "./debug-mode";

const logger = createLogger("conversation-core");

/** The conversation rows a core turn records on, as the state store keeps them for both scopes. */
export interface ConversationRowStore extends Pick<
  StateStore,
  "getConversation" | "mutateConversation"
> {
  /** The store's database, read synchronously where the answer cannot wait. */
  db(): Db;
  /** The conversation's message queue, which keeps a message a restart withdrew for review. */
  queue: Pick<MessageQueueService, "enqueue">;
}

const productionRowStore: ConversationRowStore = {
  db: getStateDb,
  getConversation,
  mutateConversation,
  queue: messageQueueService,
};

let cachedRows:
  | { db: Db; sessions: ConversationsRepo; projects: ProjectConversationsRepo }
  | undefined;
/** The committed row, read through one prepared repository per database handle, so a reopened database is never read through a closed one. */
function committedRow(
  db: Db,
  identity: ConversationIdentity,
): ConversationState | null {
  if (cachedRows?.db !== db) {
    cachedRows = {
      db,
      sessions: createConversationsRepo(db),
      projects: createProjectConversationsRepo(db),
    };
  }
  // Each scope keeps its conversations in a table of its own.
  return isProjectSentinel(identity.storeSessionName)
    ? cachedRows.projects.findById(identity.conversationId)
    : cachedRows.sessions.findById(identity.conversationId);
}

/** What a project conversation's status notification is keyed on, as the row was committed. */
type NotificationFacts = Pick<
  ConversationState,
  "promptCount" | "totalTurns" | "pendingQuestionId"
>;

function factsOf(row: NotificationFacts): NotificationFacts {
  return {
    promptCount: row.promptCount,
    totalTurns: row.totalTurns,
    pendingQuestionId: row.pendingQuestionId,
  };
}

/**
 * A project conversation tells the person when control comes back to them
 * (ready, needs input, failed), as the conversation actor's status broadcasts
 * do; the notification's key folds a repeat for the same turn into one.
 */
function notifyProjectStatus(
  identity: ConversationIdentity,
  status: "awaiting" | "waiting_for_input",
  facts: NotificationFacts,
  error: string | undefined,
): void {
  if (!isProjectSentinel(identity.storeSessionName)) return;
  void (async () => {
    await notifyProjectConversationStatusFromContext({
      projectPath: identity.projectPath,
      target: projectConversationTarget(
        getProjectDisplayName(identity.projectPath),
        identity.conversationId,
      ),
      status,
      promptCount: facts.promptCount,
      totals: { totalTurns: facts.totalTurns },
      pendingQuestion:
        facts.pendingQuestionId === null
          ? null
          : { questionId: facts.pendingQuestionId },
      lastError: error ?? null,
      lastResult: null,
    });
  })().catch((notifyError: unknown) =>
    logger.warn("conversation_core.project_notification_failed", {
      conversationId: identity.conversationId,
      status,
      error: getErrorMessage(notifyError),
    }),
  );
}

/** Status events are a projection of the committed row; a lost one never changes the row. */
function publishStatus(
  identity: ConversationIdentity,
  status: "running" | "awaiting" | "waiting_for_input",
  error?: string,
): void {
  try {
    const target = targetFromStoreSessionName(
      getProjectDisplayName(identity.projectPath),
      identity.storeSessionName,
      identity.conversationId,
    );
    publishEvent({
      type: "conversation-status",
      ...target,
      status,
      ...(error !== undefined ? { error } : {}),
    });
  } catch (error) {
    logger.warn("conversation_core.status_publish_failed", {
      conversationId: identity.conversationId,
      status,
      error: getErrorMessage(error),
    });
  }
}

function pushStatus(
  identity: ConversationIdentity,
  status: "awaiting" | "waiting_for_input",
): void {
  try {
    dispatchPushForConversationStatus({
      projectName: getProjectDisplayName(identity.projectPath),
      sessionName: identity.storeSessionName,
      conversationId: identity.conversationId,
      status,
      role: null,
    });
  } catch (error) {
    logger.warn("conversation_core.push_failed", {
      conversationId: identity.conversationId,
      error: getErrorMessage(error),
    });
  }
}

function publishUnread(identity: ConversationIdentity, unread: boolean): void {
  try {
    publishEvent({
      type: "conversation-unread",
      ...conversationEventScopeFields(
        getProjectDisplayName(identity.projectPath),
        identity.storeSessionName,
        identity.conversationId,
      ),
      unread,
    });
  } catch (error) {
    logger.warn("conversation_core.unread_publish_failed", {
      conversationId: identity.conversationId,
      unread,
      error: getErrorMessage(error),
    });
  }
}

/** The conversation row written the way every client already reads it. */
export function createProductionConversationRecords(
  rows: ConversationRowStore = productionRowStore,
): ConversationRecordPort & CustodyRecordPort & LiveInputRecordPort {
  /** The person gets control back: unread for a person's work, asked back, and a project conversation's notice. */
  function tellIdle(
    identity: ConversationIdentity,
    status: "awaiting" | "waiting_for_input",
    source: "user" | "workflow",
    unread: boolean,
    facts: NotificationFacts,
    failure: string | undefined,
    askBack: boolean,
  ): void {
    // A question still open was announced when it was asked.
    if (status === "awaiting")
      notifyProjectStatus(identity, status, facts, failure);
    if (source !== "user") return;
    publishUnread(identity, unread);
    if (status === "awaiting" && askBack) pushStatus(identity, "awaiting");
  }

  return {
    async recordLiveInput(identity) {
      await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.live_input.accepted",
        (row) => applyLiveInputAccepted(row, new Date().toISOString()),
      );
    },
    async recordSegment(identity, usage, project) {
      const written = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.custody.segment",
        (row) => {
          if (usage !== null) applySegmentUsage(row, usage);
          const shown = project();
          if (shown === null) return null;
          return {
            shown,
            status: applyCustodyRow(row, shown, new Date().toISOString()),
            unread: row.unread,
            facts: factsOf(row),
          };
        },
      );
      if (written === null) return;
      const { shown, status, unread, facts } = written;
      publishStatus(identity, status);
      // A provider turn's end hands control back as a turn's does.
      if (
        shown.status === "idle" &&
        shown.notify !== null &&
        status !== "running"
      )
        tellIdle(
          identity,
          status,
          shown.notify,
          unread,
          facts,
          undefined,
          true,
        );
    },
    async read(identity) {
      const row: ConversationState | null = await rows.getConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
      );
      return row === null
        ? null
        : {
            agentBackend: row.agentBackend,
            backendRef: row.backendRef,
            promptCount: row.promptCount,
            transcriptPath: row.transcriptPath,
            debugMode: row.debugMode,
            pendingQuestionId: row.pendingQuestionId,
            owner: row.owner,
            forkedFrom: row.forkedFrom,
            checkpointFork: row.checkpointFork,
          };
    },
    async claimTurn(identity) {
      await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.claim",
        (row) => applyTurnClaimed(row, new Date().toISOString()),
      );
      publishStatus(identity, "running");
    },
    async endClaim(identity) {
      const status = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.claim_end",
        (row) => applyClaimEnded(row),
      );
      if (status !== null) publishStatus(identity, status);
    },
    async beginTurn(identity, source) {
      const transcriptPath = await getTranscriptPath(identity.conversationId);
      await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.begin",
        (row) => {
          // Readers that resolve the transcript from the row need its path.
          row.transcriptPath ??= transcriptPath;
          applyTurnBegin(row, source, new Date().toISOString());
        },
      );
      publishStatus(identity, "running");
      if (source === "user") publishUnread(identity, false);
    },
    admitProfile: (identity) =>
      admitConversationProfileForTurn({
        projectPath: identity.projectPath,
        sessionName: identity.storeSessionName,
        conversationId: identity.conversationId,
      }),
    async adoptBackend(identity, backend) {
      await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.backend.adopt",
        (row) => applyBackendAdoption(row, backend),
      );
    },
    async recordSeenAlignment(identity, version) {
      await recordSeenAlignmentVersion(
        { mutateConversation: rows.mutateConversation },
        {
          projectPath: identity.projectPath,
          sessionName: identity.storeSessionName,
          conversationId: identity.conversationId,
          seenAlignmentVersion: version,
        },
      );
    },
    async recordContinuity(identity, ref) {
      await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.continuity",
        (row) => {
          row.backendRef = ref;
        },
      );
    },
    async recordWithdrawn(identity, { cause, request, reason }) {
      // A queue row carries no backend: a fresh conversation takes its first message's choice now,
      // at boot before anything drains, so the retried message runs where it was sent.
      const chosen = request.backend;
      if (chosen !== undefined) {
        await rows.mutateConversation(
          identity.projectPath,
          identity.storeSessionName,
          identity.conversationId,
          "conversation-core.withdrawn.backend",
          (row) => {
            if (!backendLocked(row)) row.agentBackend = chosen;
          },
        );
      }
      // The queue shows it with its images and feedback, for the person to send again or discard.
      await rows.queue.enqueue({
        projectPath: identity.projectPath,
        sessionName: identity.storeSessionName,
        conversationId: identity.conversationId,
        id: `unsent:${cause}`,
        inputOrigin: request.inputOrigin,
        content: queueContentOfTurnInput(request),
        ...(request.modelSelection !== undefined
          ? { modelSelection: request.modelSelection }
          : {}),
        failure: reason,
      });
      logger.info("conversation_core.unsent_message_kept_for_review", {
        conversationId: identity.conversationId,
      });
    },
    async recordInterrupted(identity) {
      const { status, facts } = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.interrupted",
        (row) => ({
          status: applyTurnInterrupted(row, new Date().toISOString()),
          facts: factsOf(row),
        }),
      );
      // Its turn settled the row first: the restart interrupted nothing the person sees.
      if (status === null) return;
      const interruption =
        "The server restarted while this turn was running, so it was interrupted.";
      await appendNotice({
        conversationId: identity.conversationId,
        text: interruption,
        projectName: getProjectDisplayName(identity.projectPath),
        storeSessionName: identity.storeSessionName,
      });
      publishStatus(identity, status);
      // A question still open was announced when it was asked; otherwise the turn failed, not finished.
      if (status === "awaiting")
        notifyProjectStatus(identity, status, facts, interruption);
    },
    hasPendingQuestion(identity) {
      return committedRow(rows.db(), identity)?.pendingQuestionId != null;
    },
    async withdrawQuestion(identity) {
      const withdrawn = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.question.withdraw",
        (row) =>
          applyQuestionWithdrawn(row) ? statusWithoutQuestion(row) : null,
      );
      if (withdrawn === null) return false;
      logger.info("conversation_core.question_withdrawn", {
        conversationId: identity.conversationId,
      });
      publishStatus(identity, withdrawn);
      return true;
    },
    async settleTurn(identity, settlement, source, custody) {
      const { status, debug, unread, facts } = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.turn.settle",
        (row) => {
          const now = new Date().toISOString();
          const settled = applyTurnSettlement(row, settlement, now, source);
          // The custody that kept the runtime decides what the row shows now.
          const shown = custody?.() ?? null;
          return {
            debug: settled.debug,
            status:
              shown?.status === "running"
                ? applyCustodyRow(row, shown, now)
                : settled.status,
            unread: row.unread,
            facts: factsOf(row),
          };
        },
      );
      // A failure must stay explicable after a reload, not only in a live stream.
      if (settlement.failure !== null && !settlement.failure.recorded) {
        await appendNotice({
          conversationId: identity.conversationId,
          text: `Turn stopped: ${settlement.failure.message}`,
          projectName: getProjectDisplayName(identity.projectPath),
          storeSessionName: identity.storeSessionName,
        });
      }
      const failure =
        debug?.kind === "turn_failed"
          ? debug.lastError
          : settlement.failure?.message;
      publishStatus(identity, status, failure);
      // Still running a provider turn custody holds: control comes back when that ends.
      if (status === "running") return { debug };
      // The person is asked back when the turn hands them control: not for a question (its ask
      // already did), and in debug mode only when the session's phase advanced.
      tellIdle(
        identity,
        status,
        source,
        unread,
        facts,
        failure,
        debug === null || debug.kind === "advance",
      );
      return { debug };
    },
  };
}

/**
 * Questions an agent asks the person during a core turn, recorded on the row
 * and announced the way every client already reads them.
 */
export function createProductionConversationQuestions(
  rows: ConversationRowStore = productionRowStore,
) {
  return {
    async ask(
      identity: ConversationIdentity,
      batch: QuestionBatch,
    ): Promise<boolean> {
      const asked = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.question.ask",
        (row) => (applyQuestionAsked(row, batch) ? factsOf(row) : null),
      );
      if (asked === null) return false;
      publishStatus(identity, "waiting_for_input");
      notifyProjectStatus(identity, "waiting_for_input", asked, undefined);
      try {
        const target = targetFromStoreSessionName(
          getProjectDisplayName(identity.projectPath),
          identity.storeSessionName,
          identity.conversationId,
        );
        publishEvent({
          type: "ask-question",
          ...target,
          questionId: batch.questionId,
          questions: batch.questions,
        });
        pushStatus(identity, "waiting_for_input");
      } catch (error) {
        logger.warn("conversation_core.question_announce_failed", {
          conversationId: identity.conversationId,
          error: getErrorMessage(error),
        });
      }
      return true;
    },
    async clear(
      identity: ConversationIdentity,
      questionId: string,
    ): Promise<boolean> {
      const status = await rows.mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.question.clear",
        (row) => {
          const waiting = row.status === "waiting_for_input";
          if (!applyQuestionCleared(row, questionId)) return "refused" as const;
          return waiting ? statusWithoutQuestion(row) : null;
        },
      );
      if (status === "refused") return false;
      if (status !== null) publishStatus(identity, status);
      return true;
    },
  };
}

/** Debug mode on the conversation row, announced the way every client already reads it. */
export function createProductionDebugRecords(): CoreDebugModeDeps["records"] {
  return {
    async readDebugMode(identity) {
      const row = await getConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
      );
      return row?.debugMode ?? null;
    },
    async applyCommand(identity, command) {
      const applied = await mutateConversation(
        identity.projectPath,
        identity.storeSessionName,
        identity.conversationId,
        "conversation-core.debug.command",
        (row) => {
          const effect = applyDebugCommandToRow(
            row,
            command,
            new Date().toISOString(),
          );
          return effect === null
            ? null
            : { effect, status: row.status, debugMode: row.debugMode };
        },
      );
      if (applied === null) return null;
      const { effect, status, debugMode } = applied;
      if (effect.broadcastDebugModeStatus) {
        try {
          publishEvent({
            type: "debug-mode-status",
            projectName: getProjectDisplayName(identity.projectPath),
            sessionName: identity.storeSessionName,
            conversationId: identity.conversationId,
            active: debugMode?.active ?? false,
            recording: debugMode?.recording ?? false,
          });
        } catch (error) {
          logger.warn("conversation_core.debug_status_publish_failed", {
            conversationId: identity.conversationId,
            error: getErrorMessage(error),
          });
        }
      }
      if (
        effect.broadcastConversationStatus &&
        (status === "running" ||
          status === "awaiting" ||
          status === "waiting_for_input")
      ) {
        publishStatus(identity, status, effect.lastError);
      }
      return effect;
    },
  };
}
