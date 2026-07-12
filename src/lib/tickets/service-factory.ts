import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import { getConfigDirPath, readConfig } from "@/lib/config/loader";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import { createFirstTurnDispatcher } from "@/lib/prompt/first-turn-dispatch";
import { executePromptStream } from "@/lib/prompt/sdk-driver";
import { isConversationBusy } from "@/lib/prompt/single-flight";
import {
  getCompactionService,
  getContextArtifactsRepo,
} from "@/lib/context-artifacts/route-handlers";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { createSessionAlignmentServiceForProduction } from "@/lib/session-alignment/service-factory";
import {
  createSessionNormal,
  deleteSessionIfCurrent,
} from "@/lib/sessions/service";
import { publishSessionStatus } from "@/lib/workflows/primitives/default-session-status-bus";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import {
  createReferenceDocument,
  getProjectConversation,
  getSession,
  getStateDb,
} from "@/lib/state-store";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import {
  createProjectsRepo,
  type ProjectsRepo,
} from "@/lib/state-store/projects-repo";
import {
  _resetForTesting,
  withWriteQueue,
} from "@/lib/state-store/write-queue";
import {
  appendNotice,
  readTranscriptEntriesWithSeq,
} from "@/lib/prompt/transcript";
import { executeWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  createTicketAttachmentService,
  type EnsureConversationCompactionInput,
  type EnsureConversationCompactionResult,
  type LiveCompaction,
  type TicketAttachmentService,
} from "./attachment-service";
import {
  createTicketCommandRunner,
  type TicketCommandRunner,
} from "./slash-command";
import {
  createTicketContentStore,
  TICKET_CONTENT_ROOT_DIRNAME,
  type TicketContentStore,
} from "./content-store";
import { createTicketKickoffQueuer, type TicketKickoffQueuer } from "./kickoff";
import {
  createLiveTicketContextProvider,
  type LiveTicketContextProvider,
} from "./live-context";
import {
  createTicketProjectResolver,
  type TicketProjectResolver,
} from "./project-resolver";
import {
  createTicketMaterializer,
  type TicketMaterializer,
} from "./materializer";
import {
  createTicketOperationLock,
  type TicketOperationLock,
} from "./operation-lock";
import { getTicketProjectOperationGate } from "./project-operation-gate";
import { createTicketService, type TicketService } from "./service";
import {
  createTicketStartService,
  type TicketStartService,
} from "./start-service";

/**
 * One repo per process: it shares the module-level write queue so ticket
 * writes serialize with every other state-store write, and route handlers
 * reuse the same prepared statements as the service.
 */
export function getTicketsRepo(): TicketsRepo {
  return getGlobalSingleton("__cc_tickets_repo", () =>
    createTicketsRepo(getStateDb(), { withWriteQueue, _resetForTesting }),
  );
}

function getTicketProjectsRepo(): ProjectsRepo {
  return getGlobalSingleton("__cc_ticket_projects_repo", () =>
    createProjectsRepo(getStateDb()),
  );
}

export function getTicketProjectResolver(): TicketProjectResolver {
  return getGlobalSingleton("__cc_ticket_project_resolver", () =>
    createTicketProjectResolver({
      resolveAvailableProjectPath(projectName) {
        return resolveProjectPath(projectName);
      },
      listKnownProjectPaths() {
        return getTicketProjectsRepo()
          .listAll()
          .map((project) => project.rootPath);
      },
    }),
  );
}

/** One start/delete lock per process — the keys are process-wide identities. */
export function getTicketOperationLock(): TicketOperationLock {
  return getGlobalSingleton("__cc_ticket_operation_lock", () =>
    createTicketOperationLock(),
  );
}

/** One service per process, like the state store it writes through. */
export function getTicketService(): TicketService {
  return getGlobalSingleton("__cc_ticket_service", () =>
    createTicketService({
      repo: getTicketsRepo(),
      resolveProjectPath(projectName) {
        return getTicketProjectResolver().resolveKnownProjectPath(projectName);
      },
      resolveAvailableProjectPath(projectName) {
        return resolveProjectPath(projectName);
      },
      deleteTicketContent(ticketId) {
        return getTicketContentStore().deleteTicket(ticketId);
      },
      runProjectTicketOperation(projectPath, operation) {
        return getTicketProjectOperationGate().runTicketOperation(
          projectPath,
          operation,
        );
      },
      runTicketOperation(key, fn) {
        return getTicketOperationLock().runExclusive(key, fn);
      },
      // Through the StatusBus (never the broadcaster directly): in-process
      // subscribers see the scoped envelope while the wire event is unchanged.
      broadcast(event) {
        publishSessionStatus(event);
      },
      now() {
        return new Date().toISOString();
      },
      generateId() {
        return randomUUID();
      },
    }),
  );
}

/** One provider per process; reads through the shared repo every turn. */
export function getLiveTicketContextProvider(): LiveTicketContextProvider {
  return getGlobalSingleton("__cc_live_ticket_context_provider", () =>
    createLiveTicketContextProvider({
      findLinkedTicket(projectPath, sessionName) {
        return getTicketsRepo().findLinkedTicket(projectPath, sessionName);
      },
    }),
  );
}

/** Durable attachment snapshots live under `<config-dir>/ticket-content/`. */
export function getTicketContentStore(): TicketContentStore {
  return getGlobalSingleton("__cc_ticket_content_store", () =>
    createTicketContentStore({
      contentRoot: path.join(getConfigDirPath(), TICKET_CONTENT_ROOT_DIRNAME),
      listTicketIdsForProject(projectPath) {
        return getTicketsRepo().listTicketIds(projectPath);
      },
    }),
  );
}

/** One materializer per process; registration goes through the state store. */
export function getTicketMaterializer(): TicketMaterializer {
  return getGlobalSingleton("__cc_ticket_materializer", () =>
    createTicketMaterializer({
      contentStore: getTicketContentStore(),
      registerReferenceDocument(
        projectPath,
        sessionName,
        filePath,
        description,
      ) {
        return createReferenceDocument(
          projectPath,
          sessionName,
          filePath,
          description,
        );
      },
    }),
  );
}

async function lookupConversation(
  projectPath: string,
  sessionName: string | null,
  conversationId: string,
): Promise<{
  transcriptPath: string | null;
  backendRef: AgentSessionRef | null;
} | null> {
  if (sessionName === null) {
    const conversation = await getProjectConversation(
      projectPath,
      conversationId,
    );
    return conversation
      ? {
          transcriptPath: conversation.transcriptPath,
          backendRef: conversation.backendRef ?? null,
        }
      : null;
  }
  const session = await getSession(projectPath, sessionName);
  const conversation = session?.conversations.find(
    (candidate) => candidate.id === conversationId,
  );
  return conversation
    ? {
        transcriptPath: conversation.transcriptPath,
        backendRef: conversation.backendRef ?? null,
      }
    : null;
}

async function conversationExists(
  projectPath: string,
  sessionName: string | null,
  conversationId: string,
): Promise<boolean> {
  const conversation = await lookupConversation(
    projectPath,
    sessionName,
    conversationId,
  );
  return conversation !== null;
}

/**
 * Create-if-missing conversation compaction shared by attachment adds, ticket
 * starts, and the `/ticket` runner; `trigger` is the audit tag stamped on the
 * run.
 */
async function ensureConversationCompactionForProduction(
  input: EnsureConversationCompactionInput,
  trigger: string,
): Promise<EnsureConversationCompactionResult> {
  const conversation = await lookupConversation(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );
  if (conversation === null) {
    return { ok: false, reason: "conversation not found" };
  }
  const result = await getCompactionService().trigger({
    kind: "conversation_compaction",
    scope: input.sessionName === null ? "project" : "session",
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    transcriptPath: conversation.transcriptPath,
    force: false,
    createdBy: "agent",
    trigger,
  });
  if (result.outcome === "invalid") {
    return { ok: false, reason: result.error };
  }
  let row: ContextArtifactRow;
  if (result.outcome === "already_fresh") {
    row = result.artifact;
  } else {
    try {
      row = await result.completion;
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const markdown = renderArtifactMarkdown(row);
  if (markdown === null) {
    return { ok: false, reason: row.error ?? "compaction failed" };
  }
  return { ok: true, markdown, capturedAt: row.updatedAt };
}

async function getLiveCompactionForProduction(
  conversationId: string,
): Promise<LiveCompaction | null> {
  const rows = getContextArtifactsRepo().findByConversation(conversationId);
  const current = rows.find((row) => row.kind === "conversation_compaction");
  if (current === undefined) return null;
  const markdown = renderArtifactMarkdown(current);
  return markdown === null
    ? null
    : {
        markdown,
        capturedAt: current.updatedAt,
        coveredEndSeq: current.coveredEndSeq,
      };
}

function renderArtifactMarkdown(row: ContextArtifactRow): string | null {
  if (row.status !== "complete" || row.payload === null) return null;
  // Freshness is rendered as current-as-of-capture: the attachment consumer
  // gets the read commands to fetch anything newer, so staleness accounting
  // (which needs a transcript scan) is not recomputed here.
  return compactionEnvelopeToMarkdown(row.payload, {
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
    updatedAt: row.updatedAt,
  });
}

/** One attachment service per process, sharing the ticket repo and store. */
export function getTicketAttachmentService(): TicketAttachmentService {
  return getGlobalSingleton("__cc_ticket_attachment_service", () =>
    createTicketAttachmentService({
      repo: getTicketsRepo(),
      contentStore: getTicketContentStore(),
      resolveProjectPath(projectName) {
        return getTicketProjectResolver().resolveKnownProjectPath(projectName);
      },
      runProjectTicketOperation(projectPath, operation) {
        return getTicketProjectOperationGate().runTicketOperation(
          projectPath,
          operation,
        );
      },
      ensureConversationCompaction(input) {
        return ensureConversationCompactionForProduction(
          input,
          "ticket_attachment",
        );
      },
      getLiveCompaction: getLiveCompactionForProduction,
      conversationExists,
      async getSessionOverview(projectPath, sessionName) {
        const session = await getSession(projectPath, sessionName);
        if (session === null) return null;
        return {
          sessionName: session.sessionName,
          finished: session.finished,
          conversationIds: session.conversations.map(
            (conversation) => conversation.id,
          ),
        };
      },
      isTicketStartActive(ticketId) {
        return getTicketOperationLock().isTicketStartActive(ticketId);
      },
      onTicketStartReleased(ticketId) {
        return getTicketOperationLock().onTicketStartReleased(ticketId);
      },
      broadcast(event) {
        publishSessionStatus(event);
      },
      now() {
        return new Date().toISOString();
      },
      generateId() {
        return randomUUID();
      },
    }),
  );
}

/** One start service per process, sharing the repo, store, and lock. */
export function getTicketStartService(): TicketStartService {
  return getGlobalSingleton("__cc_ticket_start_service", () =>
    createTicketStartService({
      repo: getTicketsRepo(),
      contentStore: getTicketContentStore(),
      lock: getTicketOperationLock(),
      resolveProjectPath(projectName) {
        return resolveProjectPath(projectName);
      },
      runProjectTicketOperation(projectPath, operation) {
        return getTicketProjectOperationGate().runTicketOperation(
          projectPath,
          operation,
        );
      },
      ensureConversationCompaction(input) {
        return ensureConversationCompactionForProduction(input, "ticket_start");
      },
      conversationExists,
      async getSessionLiveness(projectPath, sessionName) {
        const session = await getSession(projectPath, sessionName);
        if (session === null) return null;
        return { createdAt: session.createdAt, finished: session.finished };
      },
      async provisionSession(projectPath, sessionName) {
        const session = await createSessionNormal(projectPath, sessionName);
        const conversationId = session.conversations[0]?.id;
        if (conversationId === undefined) {
          throw new Error(
            `provisioned session ${sessionName} has no initial conversation`,
          );
        }
        return {
          worktreePath: session.worktreePath,
          branchName: session.branchName,
          conversationId,
          createdAt: session.createdAt,
        };
      },
      deleteSessionIfCurrent(projectPath, sessionName, expected) {
        return deleteSessionIfCurrent(projectPath, sessionName, expected);
      },
      materializeTicketContext(input) {
        return getTicketMaterializer().materialize(input);
      },
      async activateTicketCharter(input) {
        return getSessionAlignmentService().createAndActivateTicketCharter(
          input,
        );
      },
      queueKickoff(input) {
        return getTicketKickoffQueuer().queueKickoff(input);
      },
      broadcast(event) {
        publishSessionStatus(event);
      },
      now() {
        return new Date().toISOString();
      },
      generateId() {
        return randomUUID();
      },
    }),
  );
}

/** One `/ticket` runner per process, sharing the ticket repo and store. */
export function getTicketCommandRunner(): TicketCommandRunner {
  return getGlobalSingleton("__cc_ticket_command_runner", () =>
    createTicketCommandRunner({
      repo: getTicketsRepo(),
      contentStore: getTicketContentStore(),
      runProjectTicketOperation(projectPath, operation) {
        return getTicketProjectOperationGate().runTicketOperation(
          projectPath,
          operation,
        );
      },
      getConversation: lookupConversation,
      readTranscriptEntries: readTranscriptEntriesWithSeq,
      getLiveCompaction: getLiveCompactionForProduction,
      ensureConversationCompaction(input) {
        return ensureConversationCompactionForProduction(
          input,
          "ticket_command",
        );
      },
      executeWorkflowTaskRun,
      appendNotice,
      broadcast(event) {
        publishSessionStatus(event);
      },
      now() {
        return new Date().toISOString();
      },
      generateId() {
        return randomUUID();
      },
    }),
  );
}

/**
 * The ticket start path's alignment entrypoint. Memoized separately from the
 * alignment route handlers' private instance; both wrap the same repo/DB.
 */
function getSessionAlignmentService() {
  return getGlobalSingleton("__cc_ticket_alignment_service", () =>
    createSessionAlignmentServiceForProduction(),
  );
}

/**
 * The kickoff seam: fire-and-forget queueing with dispatch failures surfaced
 * as a durable conversation notice (design §Error Handling: Dispatch).
 */
function getTicketKickoffQueuer(): TicketKickoffQueuer {
  return getGlobalSingleton("__cc_ticket_kickoff_queuer", () =>
    createTicketKickoffQueuer({
      getSession(projectPath, sessionName) {
        return getSession(projectPath, sessionName);
      },
      dispatchFirstTurn(input) {
        return getTicketKickoffDispatcher().dispatchFirstTurn(input);
      },
      appendNotice(input) {
        return appendNotice(input);
      },
      async getDefaultAgentBackend() {
        return (await readConfig()).defaultAgentBackend;
      },
    }),
  );
}

/**
 * The kickoff path's first-turn dispatcher (shared readiness-gated primitive).
 * Ticket kickoffs always run the session's default single backend, so the
 * dual-race seam is unreachable; a throwing stub keeps that explicit instead
 * of wiring an unused collaboration dependency.
 */
function getTicketKickoffDispatcher() {
  return getGlobalSingleton("__cc_ticket_kickoff_dispatcher", () =>
    createFirstTurnDispatcher({
      executePromptStream,
      startDualRace() {
        return Promise.reject(
          new Error("ticket kickoff never starts a dual race"),
        );
      },
      isConversationBusy,
    }),
  );
}
