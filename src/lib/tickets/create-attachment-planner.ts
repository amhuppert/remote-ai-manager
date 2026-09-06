import { Buffer } from "node:buffer";
import { createLogger } from "@/lib/logging";
import type { FileSnapshot } from "./content-store";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

import {
  composeQuickTicketDiagnosticReport,
  type QuickTicketDiagnosticEnvironment,
} from "./diagnostics";
import type {
  QuickTicketConversationContext,
  QuickTicketCreateWarning,
  QuickTicketDiagnostics,
  TicketAttachment,
  TicketDetail,
} from "./schemas";

const logger = createLogger("tickets.create-attachment-planner");

export type PreparedEnrichment =
  | {
      status: "ready";
      backend: AgentBackendId;
      modelSelection: BackendModelSelection;
    }
  | { status: "unavailable"; warning: QuickTicketCreateWarning };
export interface CaptureQuickTicketScreenshotInput {
  ticketId: string;
  attachmentId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface CreateAttachmentPlannerDeps {
  resolveAvailableProjectPath(projectName: string): Promise<string | null>;
  conversationExists(
    projectPath: string,
    sessionName: string | null,
    conversationId: string,
  ): Promise<boolean>;
  captureScreenshot(
    input: CaptureQuickTicketScreenshotInput,
  ): Promise<FileSnapshot>;
  deleteSnapshot(snapshotKey: string): Promise<void>;
  diagnosticEnvironment(): QuickTicketDiagnosticEnvironment;
  prepareEnrichment(): Promise<PreparedEnrichment>;
  scheduleConversationSnapshotRefresh(input: {
    projectName: string;
    number: number;
    attachmentId: string;
  }): void;
  scheduleEnrichment(input: {
    backend: AgentBackendId;
    modelSelection: BackendModelSelection;
    ticket: TicketDetail;
    diagnostics: QuickTicketDiagnostics;
    conversationContext?: QuickTicketConversationContext;
  }): void;
  generateId(): string;
  now(): string;
}

export interface PlanCreateAttachmentsInput {
  ticketId: string;
  conversationContext?: QuickTicketConversationContext;
  diagnostics?: QuickTicketDiagnostics;
  autoStartRequested?: boolean;
}

export interface CreateAttachmentPlan {
  attachments: TicketAttachment[];
  pendingConversationAttachmentIds: string[];
  warnings: QuickTicketCreateWarning[];
  compensate(): Promise<void>;
  afterCommit(ticket: TicketDetail): void;
}

export interface CreateAttachmentPlanner {
  plan(input: PlanCreateAttachmentsInput): Promise<CreateAttachmentPlan>;
}

function timestampAfter(previous: string | null, candidate: string): string {
  const candidateMillis = Date.parse(candidate);
  if (!Number.isFinite(candidateMillis)) {
    throw new Error("quick-ticket attachment timestamp must be ISO-8601");
  }
  if (previous === null) return new Date(candidateMillis).toISOString();
  const previousMillis = Date.parse(previous);
  return new Date(Math.max(candidateMillis, previousMillis + 1)).toISOString();
}

function screenshotFileName(mediaType: "image/png" | "image/webp"): string {
  return mediaType === "image/png"
    ? "diagnostic-screenshot.png"
    : "diagnostic-screenshot.webp";
}

export function createCreateAttachmentPlanner(
  deps: CreateAttachmentPlannerDeps,
): CreateAttachmentPlanner {
  return {
    async plan(input) {
      const attachments: TicketAttachment[] = [];
      const pendingConversationAttachmentIds: string[] = [];
      const warnings: QuickTicketCreateWarning[] = [];
      const capturedSnapshotKeys: string[] = [];
      let acceptedConversationContext:
        | QuickTicketConversationContext
        | undefined;
      let previousTimestamp: string | null = null;

      function nextTimestamp(): string {
        const timestamp = timestampAfter(previousTimestamp, deps.now());
        previousTimestamp = timestamp;
        return timestamp;
      }

      function addAttachment(
        attachment: Omit<TicketAttachment, "createdAt" | "updatedAt">,
      ): void {
        const timestamp = nextTimestamp();
        attachments.push({
          ...attachment,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      let compensated = false;
      async function compensate(): Promise<void> {
        if (compensated) return;
        compensated = true;
        for (const snapshotKey of capturedSnapshotKeys) {
          try {
            await deps.deleteSnapshot(snapshotKey);
          } catch (error) {
            logger.warn(
              "tickets.create_attachment_planner.compensation_failed",
              {
                ticketId: input.ticketId,
                snapshotKey,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }

      try {
        const diagnostics = input.diagnostics;
        if (diagnostics !== undefined) {
          const markdown = composeQuickTicketDiagnosticReport(
            diagnostics,
            deps.diagnosticEnvironment(),
          );
          if (markdown !== null) {
            addAttachment({
              id: deps.generateId(),
              ticketId: input.ticketId,
              description: "Command Center diagnostic report",
              payload: { kind: "note", markdown },
            });
          }

          if (
            diagnostics.screenshot !== undefined &&
            !diagnostics.removed.includes("screenshot")
          ) {
            const attachmentId = deps.generateId();
            const fileName = screenshotFileName(
              diagnostics.screenshot.mediaType,
            );
            const snapshot = await deps.captureScreenshot({
              ticketId: input.ticketId,
              attachmentId,
              fileName,
              bytes: new Uint8Array(
                Buffer.from(diagnostics.screenshot.base64, "base64"),
              ),
            });
            capturedSnapshotKeys.push(snapshot.snapshotKey);
            addAttachment({
              id: attachmentId,
              ticketId: input.ticketId,
              description:
                "Page state behind the dialog when the bug was filed",
              payload: {
                kind: "file",
                fileName: snapshot.fileName,
                snapshotKey: snapshot.snapshotKey,
                mediaType: diagnostics.screenshot.mediaType,
                sizeBytes: snapshot.sizeBytes,
                sha256: snapshot.sha256,
              },
            });
          }
        }

        const contextRemoved =
          diagnostics?.removed.includes("conversation") ?? false;
        const conversationContext = input.conversationContext;
        if (conversationContext !== undefined && !contextRemoved) {
          const sourceProjectPath = await deps.resolveAvailableProjectPath(
            conversationContext.sourceProjectName,
          );
          if (sourceProjectPath === null) {
            warnings.push({
              code: "conversation_source_unavailable",
              message: `Conversation context was not attached because project '${conversationContext.sourceProjectName}' is unavailable.`,
            });
            logger.info(
              "tickets.create_attachment_planner.source_project_unavailable",
              { sourceProjectName: conversationContext.sourceProjectName },
            );
          } else {
            let sourceExists = false;
            try {
              sourceExists = await deps.conversationExists(
                sourceProjectPath,
                conversationContext.sessionName,
                conversationContext.conversationId,
              );
            } catch (error) {
              logger.warn(
                "tickets.create_attachment_planner.conversation_lookup_failed",
                {
                  sourceProjectName: conversationContext.sourceProjectName,
                  conversationId: conversationContext.conversationId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }

            const attachmentId = deps.generateId();
            const failed = !sourceExists;
            addAttachment({
              id: attachmentId,
              ticketId: input.ticketId,
              description:
                diagnostics !== undefined
                  ? "Conversation active when the bug was observed"
                  : (conversationContext.title ?? "Conversation context"),
              payload: failed
                ? {
                    kind: "conversation",
                    projectPath: sourceProjectPath,
                    sessionName: conversationContext.sessionName,
                    conversationId: conversationContext.conversationId,
                    snapshotKey: null,
                    snapshotCapturedAt: null,
                    snapshotStatus: "failed",
                    snapshotError: "The source conversation is unavailable.",
                  }
                : {
                    kind: "conversation",
                    projectPath: sourceProjectPath,
                    sessionName: conversationContext.sessionName,
                    conversationId: conversationContext.conversationId,
                    snapshotKey: null,
                    snapshotCapturedAt: null,
                    snapshotStatus: "pending",
                  },
            });
            acceptedConversationContext = conversationContext;
            if (!failed) {
              pendingConversationAttachmentIds.push(attachmentId);
            }
          }
        }

        let enrichment:
          | Extract<PreparedEnrichment, { status: "ready" }>
          | undefined;
        if (diagnostics !== undefined && input.autoStartRequested !== true) {
          try {
            const prepared = await deps.prepareEnrichment();
            if (prepared.status === "ready") enrichment = prepared;
            else warnings.push(prepared.warning);
          } catch (error) {
            warnings.push({
              code: "enrichment_unavailable",
              message:
                "Ticket created. Automatic enrichment is unavailable because its configuration could not be prepared.",
            });
            logger.warn("tickets.enrichment_unavailable", {
              ticketId: input.ticketId,
              phase: "preparation",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        logger.info("tickets.create_attachment_planner.plan_complete", {
          ticketId: input.ticketId,
          attachmentCount: attachments.length,
          pendingSnapshotCount: pendingConversationAttachmentIds.length,
          warningCount: warnings.length,
        });
        function afterCommit(ticket: TicketDetail): void {
          for (const attachmentId of pendingConversationAttachmentIds) {
            try {
              deps.scheduleConversationSnapshotRefresh({
                projectName: ticket.projectName,
                number: ticket.number,
                attachmentId,
              });
            } catch (error) {
              logger.warn(
                "tickets.create_attachment_planner.snapshot_schedule_failed",
                {
                  projectName: ticket.projectName,
                  number: ticket.number,
                  attachmentId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }
          if (diagnostics === undefined || enrichment === undefined) {
            return;
          }
          try {
            deps.scheduleEnrichment({
              backend: enrichment.backend,
              modelSelection: enrichment.modelSelection,
              ticket,
              diagnostics,
              ...(acceptedConversationContext !== undefined
                ? { conversationContext: acceptedConversationContext }
                : {}),
            });
          } catch (error) {
            logger.warn(
              "tickets.create_attachment_planner.enrichment_schedule_failed",
              {
                projectName: ticket.projectName,
                number: ticket.number,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        return {
          attachments,
          pendingConversationAttachmentIds,
          warnings,
          compensate,
          afterCommit,
        };
      } catch (error) {
        await compensate();
        throw error;
      }
    },
  };
}
