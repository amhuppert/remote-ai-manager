import { z } from "zod";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import { conversationProfileSelectionSchema } from "@/lib/conversations/schemas";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import type { ProjectModelSelectionValidation } from "@/lib/agent-backends/conversation";
import { ModelSelectionAdmissionError } from "@/lib/agent-backends/model-selection-admission";
import {
  TicketSessionNotLinkableError,
  type EndSessionLinkInput,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import {
  buildAttachmentIndex,
  renderAttachmentIndexLines,
} from "./attachment-index";
import { publishTicketChange } from "./events";
import type {
  MaterializedTicketEntry,
  MaterializeTicketContextInput,
} from "./materializer";
import { ticketOperationKey, type TicketOperationLock } from "./operation-lock";
import {
  effectiveSnapshotStatus,
  ticketStartModeSchema,
  type StartTicketOutput,
  type TicketAttachment,
  type TicketDetail,
  type TicketError,
  type TicketResult,
  type TicketSessionLink,
  type TicketStartMode,
} from "./schemas";
import { formatTicketIdentifier } from "./references";
import { toTicketValidationIssues } from "./service";

const logger = createLogger("tickets.start");

// ============================================================
// Contract
// ============================================================

export const startTicketServiceInputSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
    mode: ticketStartModeSchema,
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    model: z
      .never({ error: "Use the complete modelSelection instead of model." })
      .optional(),
    reasoningEffort: z
      .never({
        error: "Put reasoning effort in modelSelection.parameters.",
      })
      .optional(),
    /**
     * Identity for the provisioned session's initial conversation. Separate from
     * the complete model selection above and optional on the wire: omitting it
     * resolves the Standard Agent at the construction site (R7). Applies in both
     * start modes — a prepared session's first manual turn runs under it too.
     */
    profile: conversationProfileSelectionSchema.optional(),
  })
  .strict();
export type StartTicketServiceInput = z.input<
  typeof startTicketServiceInputSchema
>;

export interface TicketStartService {
  start(
    input: StartTicketServiceInput,
  ): Promise<TicketResult<StartTicketOutput>>;
}

// ============================================================
// Dependencies (method syntax → bivariant params)
// ============================================================

export interface ProvisionedTicketSession {
  worktreePath: string;
  branchName: string;
  /** The provisioned session's initial conversation. */
  conversationId: string;
  /** Incarnation token checked atomically when the ticket link is committed. */
  createdAt: string;
}

export interface TicketSessionLiveness {
  createdAt: string;
  finished: boolean;
}

export type TicketSessionCompensationResult =
  | { deleted: true; worktreeRemoved: boolean }
  | { deleted: false; reason: "missing" | "replaced" | "finished" };

export interface TicketKickoffInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  /** Names the ticket in the user-visible dispatch-failure notice. */
  ticketIdentifier: string;
  prompt: string;
  backend?: AgentBackendId;
  modelSelection?: BackendModelSelection;
}

export interface TicketStartServiceDeps {
  repo: TicketsRepo;
  lock: TicketOperationLock;
  resolveProjectPath(projectName: string): Promise<string | null>;
  /** Serializes the complete start workflow against project deletion. */
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  getDefaultAgentBackend(): Promise<AgentBackendId>;
  admitModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection?: BackendModelSelection;
  }): Promise<ProjectModelSelectionValidation>;
  /**
   * Hands an unsettled conversation attachment to the background snapshot
   * refresher; capture never runs inside the start request.
   */
  scheduleConversationSnapshotRefresh(input: {
    projectName: string;
    number: number;
    attachmentId: string;
  }): void;
  /** Null when the session row does not exist. */
  getSessionLiveness(
    projectPath: string,
    sessionName: string,
  ): Promise<TicketSessionLiveness | null>;
  provisionSession(
    projectPath: string,
    sessionName: string,
    /** Identity for the session's initial conversation; default when absent. */
    profile?: AgentProfileRef,
  ): Promise<ProvisionedTicketSession>;
  deleteSessionIfCurrent(
    projectPath: string,
    sessionName: string,
    expected: Pick<
      ProvisionedTicketSession,
      "createdAt" | "worktreePath" | "branchName"
    >,
  ): Promise<TicketSessionCompensationResult>;
  materializeTicketContext(
    input: MaterializeTicketContextInput,
  ): Promise<MaterializedTicketEntry[]>;
  activateTicketCharter(input: {
    projectPath: string;
    sessionName: string;
    ticketIdentifier: string;
    title: string;
    description: string;
  }): Promise<unknown>;
  /**
   * Queue the session's first agent turn (the existing first-turn dispatcher).
   * Returns whether the turn was queued; called only in agent mode and only
   * after the link transaction commits. A failure never rolls the start back
   * — the linked session stays usable in prepared shape. A decline here is
   * surfaced through `initialPromptQueued`; a failure after queueing is the
   * implementation's to surface as a user-visible notice (design §Error
   * Handling: Dispatch).
   */
  queueKickoff(input: TicketKickoffInput): Promise<boolean>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

// ============================================================
// Helpers
// ============================================================

const SESSION_NAME_LIMIT = 100;
const TICKET_SESSION_PREFIX = "Ticket: ";

/** Human-readable, restart-safe session name derived from the ticket title. */
export function buildTicketSessionName(
  _number: number,
  title: string,
  ordinal: number,
): string {
  const suffix = ordinal === 1 ? "" : ` (${ordinal})`;
  const titleBudget =
    SESSION_NAME_LIMIT - TICKET_SESSION_PREFIX.length - suffix.length;
  let preservedTitle = title.slice(0, titleBudget);
  const lastCodeUnit = preservedTitle.charCodeAt(preservedTitle.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    preservedTitle = preservedTitle.slice(0, -1);
  }
  return `${TICKET_SESSION_PREFIX}${preservedTitle}${suffix}`;
}

/**
 * The agent-mode kickoff prompt (requirement 4.5): identifier, title,
 * description, and the shared attachment index in the live block's bounded
 * mode — every entry present, descriptions shortened with an explicit
 * ellipsis, exact retrieval commands so the agent pulls full content itself.
 */
export function buildTicketKickoffPrompt(input: {
  identifier: string;
  title: string;
  description: string;
  attachments: TicketAttachment[];
}): string {
  const entries = buildAttachmentIndex({
    identifier: input.identifier,
    attachments: input.attachments,
    mode: "bounded",
  });
  const indexBlock =
    entries.length === 0
      ? "The ticket has no attachments."
      : [
          "Attached context (retrieve any entry in full with its command):",
          ...renderAttachmentIndexLines(entries),
        ].join("\n");
  return [
    `You are starting work on ticket ${input.identifier}: ${input.title}`,
    ...(input.description === "" ? [] : [input.description]),
    indexBlock,
  ].join("\n\n");
}

function fail<T>(error: TicketError): TicketResult<T> {
  return { ok: false, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  );
}

/** Internal marker: a link insert lost to a genuinely live session. */
class LiveSessionConflictError extends Error {
  constructor(readonly sessionName: string) {
    super(`session ${sessionName} is live`);
    this.name = "LiveSessionConflictError";
  }
}

type StaleLinkReason = "finished" | "deleted" | "replaced";

interface PendingStaleLinkDemotion {
  link: TicketSessionLink;
  reason: StaleLinkReason;
}

/**
 * Classify an open link against its session row: null when the link is
 * genuinely live, otherwise the demotion reason. Exact incarnation equality
 * is required because `linkedAt` is a logical ticket revision, not wall time.
 * Legacy links without a captured incarnation are conservatively historical.
 */
function classifyStaleLink(
  link: TicketSessionLink,
  liveness: TicketSessionLiveness | null,
): StaleLinkReason | null {
  if (liveness === null) return "deleted";
  if (
    link.sessionCreatedAt === null ||
    liveness.createdAt !== link.sessionCreatedAt
  ) {
    return "replaced";
  }
  if (liveness.finished) return "finished";
  return null;
}

// ============================================================
// Factory
// ============================================================

export function createTicketStartService(
  deps: TicketStartServiceDeps,
): TicketStartService {
  async function findAvailableSessionName(
    projectPath: string,
    identifier: string,
    ticket: TicketDetail,
  ): Promise<string> {
    let ordinal = ticket.sessions.length + 1;
    while (true) {
      const sessionName = buildTicketSessionName(
        ticket.number,
        ticket.title,
        ordinal,
      );
      const existing = await deps.getSessionLiveness(projectPath, sessionName);
      if (existing === null) return sessionName;
      logger.info("start.session_name_occupied", {
        identifier,
        sessionName,
        ordinal,
        createdAt: existing.createdAt,
        finished: existing.finished,
      });
      ordinal += 1;
    }
  }

  /**
   * Hand every unsettled conversation attachment to the background refresher.
   * Capture is a multi-minute LLM run that the start must never wait on, so a
   * snapshot that was never captured — or whose earlier capture failed —
   * converges after the session is already usable.
   */
  function scheduleUnsettledSnapshotRefreshes(
    projectName: string,
    number: number,
    attachments: TicketAttachment[],
  ): void {
    for (const attachment of attachments) {
      const payload = attachment.payload;
      if (payload.kind !== "conversation") continue;
      if (effectiveSnapshotStatus(payload) === "captured") continue;
      try {
        deps.scheduleConversationSnapshotRefresh({
          projectName,
          number,
          attachmentId: attachment.id,
        });
      } catch (error) {
        // The start is already committed; an unreachable refresher leaves a
        // pending attachment the retry command can settle by hand.
        logger.warn("start.snapshot_schedule_failed", {
          projectName,
          number,
          attachmentId: attachment.id,
          error: errorMessage(error),
        });
      }
    }
  }

  function buildStaleLinkDemotions(
    staleLinks: PendingStaleLinkDemotion[],
  ): EndSessionLinkInput[] {
    return staleLinks.map(({ link, reason }) => ({
      linkId: link.id,
      endedAt: deps.now(),
      endReason: reason,
    }));
  }

  function logStaleLinkDemotions(staleLinks: PendingStaleLinkDemotion[]): void {
    for (const { link, reason } of staleLinks) {
      logger.info("start.stale_link_demoted", {
        linkId: link.id,
        ticketId: link.ticketId,
        sessionName: link.sessionName,
        reason,
      });
    }
  }

  /**
   * The final link-plus-status transaction. A unique violation means an open
   * link holds the (project, session name) slot: a stale one is reconciled and
   * the insert retried exactly once; a live one is the standard conflict.
   */
  async function linkWithReconcileRetry(
    projectPath: string,
    number: number,
    sessionName: string,
    sessionCreatedAt: string,
    mode: TicketStartMode,
    staleLinks: PendingStaleLinkDemotion[],
  ): Promise<{
    linked: TicketDetail;
    demotions: PendingStaleLinkDemotion[];
  }> {
    const attempt = (demotions: PendingStaleLinkDemotion[]) =>
      deps.repo.linkStartedSession({
        id: deps.generateId(),
        projectPath,
        number,
        sessionName,
        sessionCreatedAt,
        startMode: mode,
        linkedAt: deps.now(),
        staleLinkDemotions: buildStaleLinkDemotions(demotions),
      });
    try {
      const linked = await attempt(staleLinks);
      logStaleLinkDemotions(staleLinks);
      return { linked, demotions: staleLinks };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const conflicting = await deps.repo.findOpenSessionLink(
        projectPath,
        sessionName,
      );
      if (conflicting === null) throw error;
      const liveness = await deps.getSessionLiveness(projectPath, sessionName);
      const staleReason = classifyStaleLink(conflicting, liveness);
      if (staleReason === null) {
        throw new LiveSessionConflictError(sessionName);
      }
      const reconciled = [
        ...staleLinks,
        { link: conflicting, reason: staleReason },
      ];
      const linked = await attempt(reconciled);
      logStaleLinkDemotions(reconciled);
      return { linked, demotions: reconciled };
    }
  }

  async function publishForeignDemotions(
    startedTicketId: string,
    demotions: PendingStaleLinkDemotion[],
  ): Promise<void> {
    const publishedTicketIds = new Set<string>();
    for (const { link } of demotions) {
      if (
        link.ticketId === startedTicketId ||
        publishedTicketIds.has(link.ticketId)
      ) {
        continue;
      }
      publishedTicketIds.add(link.ticketId);
      try {
        const detail = await deps.repo.findById(link.ticketId);
        if (detail === null) continue;
        const listItem = await deps.repo.findListItem(
          detail.projectPath,
          detail.number,
        );
        if (listItem === null) continue;
        publishTicketChange({
          publish: deps.publish,
          logger,
          change: "session",
          projectName: detail.projectName,
          ticketNumber: detail.number,
          listItem,
          attachmentIndexChanged: false,
          linkedSessionName: link.sessionName,
        });
      } catch (error) {
        logger.warn("start.demotion_event_preparation_failed", {
          ticketId: link.ticketId,
          sessionName: link.sessionName,
          error: errorMessage(error),
        });
      }
    }
  }

  async function startLocked(
    projectPath: string,
    projectName: string,
    number: number,
    mode: TicketStartMode,
    kickoffConfig: {
      backend?: AgentBackendId;
      modelSelection?: BackendModelSelection;
    },
    /**
     * Prompt identity for the provisioned session's initial conversation. A
     * parameter of its own rather than a `kickoffConfig` field: that object is
     * the runtime cascade, and a profile carries no runtime.
     */
    profile: AgentProfileRef | undefined,
    bindTicketId: (ticketId: string) => void,
  ): Promise<TicketResult<StartTicketOutput>> {
    // The lock-entry snapshot: field/attachment CRUD stays lock-free, so this
    // detail (not any later re-read) is what materialization works from.
    const ticket = await deps.repo.find(projectPath, number);
    if (ticket === null) {
      return fail({
        code: "ticket_not_found",
        identifier: formatTicketIdentifier(projectName, number),
      });
    }
    bindTicketId(ticket.id);
    const identifier = formatTicketIdentifier(projectName, number);

    const openLink =
      ticket.sessions.find((link) => link.endedAt === null) ?? null;
    const staleLinks: PendingStaleLinkDemotion[] = [];
    if (openLink !== null) {
      const liveness = await deps.getSessionLiveness(
        projectPath,
        openLink.sessionName,
      );
      const staleReason = classifyStaleLink(openLink, liveness);
      if (staleReason === null) {
        logger.info("start.active_conflict", {
          identifier,
          sessionName: openLink.sessionName,
        });
        return fail({
          code: "active_session",
          sessionName: openLink.sessionName,
        });
      }
      staleLinks.push({ link: openLink, reason: staleReason });
      logger.info("start.stale_link_detected", {
        linkId: openLink.id,
        ticketId: openLink.ticketId,
        sessionName: openLink.sessionName,
        reason: staleReason,
      });
    }

    const sessionName = await findAvailableSessionName(
      projectPath,
      identifier,
      ticket,
    );

    let provisioned: ProvisionedTicketSession;
    try {
      provisioned = await deps.provisionSession(
        projectPath,
        sessionName,
        profile,
      );
    } catch (error) {
      logger.error("start.provision_failed", {
        identifier,
        sessionName,
        error: errorMessage(error),
      });
      return fail({
        code: "session_provision_failed",
        reason: errorMessage(error),
      });
    }

    let linked: TicketDetail;
    let committedDemotions: PendingStaleLinkDemotion[] = [];
    try {
      await deps.materializeTicketContext({
        projectPath,
        sessionName,
        worktreePath: provisioned.worktreePath,
        ticketNumber: number,
        attachments: ticket.attachments,
      });
      await deps.activateTicketCharter({
        projectPath,
        sessionName,
        ticketIdentifier: identifier,
        title: ticket.title,
        description: ticket.description,
      });
      const linkResult = await linkWithReconcileRetry(
        projectPath,
        number,
        sessionName,
        provisioned.createdAt,
        mode,
        staleLinks,
      );
      linked = linkResult.linked;
      committedDemotions = linkResult.demotions;
    } catch (error) {
      // A lifecycle change means the provisioned incarnation is already gone
      // or externally owned; deleting by name could remove its replacement.
      if (error instanceof TicketSessionNotLinkableError) {
        logger.info("start.compensation_skipped", {
          identifier,
          sessionName,
          reason: error.reason,
        });
      } else {
        try {
          const compensation = await deps.deleteSessionIfCurrent(
            projectPath,
            sessionName,
            {
              createdAt: provisioned.createdAt,
              worktreePath: provisioned.worktreePath,
              branchName: provisioned.branchName,
            },
          );
          if (!compensation.deleted) {
            logger.info("start.compensation_skipped", {
              identifier,
              sessionName,
              reason: compensation.reason,
            });
          } else {
            logger.info("start.compensated", { identifier, sessionName });
          }
        } catch (compensationError) {
          logger.error("start.compensation_failed", {
            identifier,
            sessionName,
            error: errorMessage(compensationError),
          });
        }
      }
      if (error instanceof LiveSessionConflictError) {
        return fail({ code: "active_session", sessionName: error.sessionName });
      }
      logger.error("start.preparation_failed", {
        identifier,
        sessionName,
        error: errorMessage(error),
      });
      // Post-provision failures keep their server-failure classification
      // (design §Error Handling: Preparation) — never the content arm.
      return fail({
        code: "context_preparation_failed",
        phase: "preparation",
        reason: errorMessage(error),
      });
    }

    await publishForeignDemotions(linked.id, committedDemotions);
    scheduleUnsettledSnapshotRefreshes(projectName, number, ticket.attachments);

    // Kickoff strictly after the link transaction committed, so the first
    // turn already sees the live ticket block. A queue decline surfaces
    // through `initialPromptQueued`; post-queue dispatch failures surface as
    // the queuer's conversation notice — either way the linked session stays
    // usable (design §Error Handling: Dispatch).
    let initialPromptQueued = false;
    if (mode === "agent") {
      const prompt = buildTicketKickoffPrompt({
        identifier,
        title: ticket.title,
        description: ticket.description,
        attachments: ticket.attachments,
      });
      try {
        initialPromptQueued = await deps.queueKickoff({
          projectPath,
          projectName,
          sessionName,
          conversationId: provisioned.conversationId,
          ticketIdentifier: identifier,
          prompt,
          ...kickoffConfig,
        });
      } catch (error) {
        logger.error("start.kickoff_failed", {
          identifier,
          sessionName,
          error: errorMessage(error),
        });
      }
      logger.info("start.kickoff_settled", {
        identifier,
        sessionName,
        queued: initialPromptQueued,
        promptLength: prompt.length,
      });
    }

    try {
      const listItem = await deps.repo.findListItem(projectPath, number);
      publishTicketChange({
        publish: deps.publish,
        logger,
        change: "session",
        projectName,
        ticketNumber: number,
        listItem,
        attachmentIndexChanged: false,
        linkedSessionName: sessionName,
      });
    } catch (error) {
      logger.warn("start.event_preparation_failed", {
        identifier,
        sessionName,
        error: errorMessage(error),
      });
    }

    logger.info("start.completed", {
      identifier,
      sessionName,
      mode,
      attachmentCount: ticket.attachments.length,
    });
    return {
      ok: true,
      value: {
        ticket: linked,
        sessionName,
        conversationId: provisioned.conversationId,
        initialPromptQueued,
      },
    };
  }

  return {
    async start(input) {
      const parsed = startTicketServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail({
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        });
      }
      const { projectName, number, mode, backend, modelSelection, profile } =
        parsed.data;
      if (mode === "prepared" && modelSelection !== undefined) {
        throw new ModelSelectionAdmissionError({
          code: "model_selection_inapplicable",
          message:
            "modelSelection is not supported in prepared mode because no initial agent turn is queued.",
          modelId: modelSelection.modelId,
        });
      }
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return fail({
          code: "ticket_not_found",
          identifier: formatTicketIdentifier(projectName, number),
        });
      }

      let kickoffConfig: {
        backend?: AgentBackendId;
        modelSelection?: BackendModelSelection;
      } = {};
      if (mode === "agent") {
        const effectiveBackend =
          backend ?? (await deps.getDefaultAgentBackend());
        const admission = await deps.admitModelSelection({
          backend: effectiveBackend,
          projectPath,
          modelSelection,
        });
        if (!admission.ok) {
          logger.warn("model_selection.rejected", {
            backend: effectiveBackend,
            modelId: admission.modelId,
            code: admission.code,
            ...(admission.parameterId !== undefined
              ? { parameterId: admission.parameterId }
              : {}),
            projectName,
            number,
          });
          throw new ModelSelectionAdmissionError(admission);
        }
        logger.debug("model_selection.resolved", {
          backend: effectiveBackend,
          modelId: admission.modelSelection.modelId,
          parameterIds: Object.keys(admission.modelSelection.parameters).sort(),
          sourceLayer:
            modelSelection === undefined
              ? "configured_default"
              : "ticket_start_request",
          projectName,
          number,
        });
        kickoffConfig = {
          backend: effectiveBackend,
          modelSelection: admission.modelSelection,
        };
      }

      return deps.runProjectTicketOperation(projectPath, async () => {
        const hold = deps.lock.tryAcquireStart(
          ticketOperationKey(projectPath, number),
        );
        if (hold === null) {
          logger.info("start.in_progress_conflict", {
            projectName,
            number,
          });
          return fail({
            code: "start_in_progress",
            identifier: formatTicketIdentifier(projectName, number),
          });
        }
        const startedAt = Date.now();
        try {
          return await startLocked(
            projectPath,
            projectName,
            number,
            mode,
            kickoffConfig,
            profile,
            (id) => hold.bindTicketId(id),
          );
        } finally {
          hold.release();
          logger.debug("start.finished", {
            projectName,
            number,
            durationMs: Date.now() - startedAt,
          });
        }
      });
    },
  };
}
