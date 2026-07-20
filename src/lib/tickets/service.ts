import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import type { CreateAttachmentPlanner } from "./create-attachment-planner";
import { publishTicketChange } from "./events";
import { ticketOperationKey } from "./operation-lock";
import type { TicketProjectOperationContext } from "./project-operation-gate";
import { formatTicketIdentifier } from "./references";
import {
  createTicketInputSchema,
  ticketIdentitySchema,
  ticketListQuerySchema,
  updateTicketFieldsSchema,
  type DeletedTicket,
  type QuickTicketCreateWarning,
  type TicketChangedEvent,
  type TicketDetail,
  type TicketError,
  type TicketIdentity,
  type TicketListItem,
  type TicketResult,
  type TicketValidationIssue,
} from "./schemas";

const logger = createLogger("tickets.service");

// ============================================================
// Service boundary inputs (safeParsed; project identity by name)
// ============================================================

export const createTicketServiceInputSchema =
  createTicketInputSchema.safeExtend({
    projectName: z.string().min(1),
  });
export type CreateTicketServiceInput = z.input<
  typeof createTicketServiceInputSchema
>;

export const updateTicketServiceInputSchema = updateTicketFieldsSchema.extend({
  projectName: z.string().min(1),
  number: z.number().int().positive(),
});
export type UpdateTicketServiceInput = z.input<
  typeof updateTicketServiceInputSchema
>;

export const listTicketsServiceQuerySchema = ticketListQuerySchema
  .omit({ projectPath: true })
  .extend({ projectName: z.string().min(1).optional() });
export type ListTicketsServiceQuery = z.input<
  typeof listTicketsServiceQuerySchema
>;

// ============================================================
// Service contract
// ============================================================

export interface TicketService {
  create(input: CreateTicketServiceInput): Promise<TicketCreateResult>;
  list(query: ListTicketsServiceQuery): Promise<TicketResult<TicketListItem[]>>;
  get(identity: TicketIdentity): Promise<TicketResult<TicketDetail>>;
  update(input: UpdateTicketServiceInput): Promise<TicketResult<TicketDetail>>;
  delete(identity: TicketIdentity): Promise<TicketResult<DeletedTicket>>;
}

export type TicketCreateResult =
  | {
      ok: true;
      value: TicketDetail;
      warnings: QuickTicketCreateWarning[];
    }
  | { ok: false; error: TicketError };

export interface TicketServiceDeps {
  repo: TicketsRepo;
  attachmentPlanner: CreateAttachmentPlanner;
  /** Resolves retained project identity even when its checkout is missing. */
  resolveProjectPath(projectName: string): Promise<string | null>;
  /** Resolves only a currently available checkout that can own new work. */
  resolveAvailableProjectPath(projectName: string): Promise<string | null>;
  deleteTicketContent(ticketId: string): Promise<void>;
  publish: PublishFn;
  /** Serializes ticket mutations against deletion of their owning project. */
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T>;
  /**
   * Serializes delete with an in-flight start on the same ticket key
   * (see `operation-lock.ts`); the delete queues until the key frees.
   */
  runTicketOperation<T>(key: string, fn: () => Promise<T>): Promise<T>;
  now(): string;
  generateId(): string;
}

// ============================================================
// Helpers
// ============================================================

export function toTicketValidationIssues(
  error: z.ZodError,
): TicketValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function validationFailed<T>(issues: TicketValidationIssue[]): TicketResult<T> {
  return { ok: false, error: { code: "validation_failed", issues } };
}

function createValidationFailed(
  issues: TicketValidationIssue[],
): TicketCreateResult {
  return { ok: false, error: { code: "validation_failed", issues } };
}

function ticketNotFound<T>(
  projectName: string,
  number: number,
): TicketResult<T> {
  const error: TicketError = {
    code: "ticket_not_found",
    identifier: formatTicketIdentifier(projectName, number),
  };
  return { ok: false, error };
}

function unknownProjectIssue(projectName: string): TicketValidationIssue {
  return { path: "projectName", message: `unknown project: ${projectName}` };
}

export function createTicketService(deps: TicketServiceDeps): TicketService {
  function publishChange(
    change: TicketChangedEvent["change"],
    projectName: string,
    ticketNumber: number,
    listItem: TicketListItem | null,
    attachmentIndexChanged = false,
  ): void {
    publishTicketChange({
      publish: deps.publish,
      logger,
      change,
      projectName,
      ticketNumber,
      listItem,
      attachmentIndexChanged,
    });
  }

  async function publishUpdatedChange(
    projectPath: string,
    projectName: string,
    ticketNumber: number,
  ): Promise<void> {
    try {
      const listItem = await deps.repo.findListItem(projectPath, ticketNumber);
      publishChange("updated", projectName, ticketNumber, listItem);
    } catch (error) {
      logger.warn("tickets.service.change_event_preparation_failed", {
        projectName,
        number: ticketNumber,
        operation: "update",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async create(input) {
      const parsed = createTicketServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.service.create.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return createValidationFailed(toTicketValidationIssues(parsed.error));
      }
      const {
        projectName,
        conversationContext,
        diagnostics,
        autoStartRequested,
        ...fields
      } = parsed.data;
      const candidateProjectPath =
        await deps.resolveAvailableProjectPath(projectName);
      if (candidateProjectPath === null) {
        logger.info("tickets.service.create.unknown_project", { projectName });
        return createValidationFailed([unknownProjectIssue(projectName)]);
      }

      return deps.runProjectTicketOperation(
        candidateProjectPath,
        async (context) => {
          if (context.projectDeletionPrecededOperation) {
            logger.info(
              "tickets.service.create.project_deleted_while_waiting",
              {
                projectName,
              },
            );
            return createValidationFailed([unknownProjectIssue(projectName)]);
          }
          const currentProjectPath =
            await deps.resolveAvailableProjectPath(projectName);
          if (currentProjectPath !== candidateProjectPath) {
            logger.info("tickets.service.create.project_unavailable", {
              projectName,
            });
            return createValidationFailed([unknownProjectIssue(projectName)]);
          }

          const ticketId = deps.generateId();
          const timestamp = deps.now();
          const plan = await deps.attachmentPlanner.plan({
            ticketId,
            ...(conversationContext !== undefined
              ? { conversationContext }
              : {}),
            ...(diagnostics !== undefined ? { diagnostics } : {}),
            ...(autoStartRequested !== undefined ? { autoStartRequested } : {}),
          });
          let detail: TicketDetail;
          try {
            detail = await deps.repo.createWithAttachments(
              {
                id: ticketId,
                projectPath: currentProjectPath,
                title: fields.title,
                description: fields.description,
                workType: fields.workType,
                status: fields.status,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              plan.attachments,
            );
          } catch (error) {
            await plan.compensate();
            throw error;
          }

          logger.info("tickets.service.created", {
            projectName,
            number: detail.number,
            workType: detail.workType,
            status: detail.status,
            attachmentCount: detail.attachments.length,
            warningCount: plan.warnings.length,
          });
          try {
            const listItem = await deps.repo.findListItem(
              currentProjectPath,
              detail.number,
            );
            publishChange(
              "created",
              projectName,
              detail.number,
              listItem,
              detail.attachments.length > 0,
            );
          } catch (error) {
            logger.warn("tickets.service.change_event_preparation_failed", {
              projectName,
              number: detail.number,
              operation: "create",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            plan.afterCommit(detail);
          } catch (error) {
            logger.warn("tickets.service.post_create_schedule_failed", {
              projectName,
              number: detail.number,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return { ok: true, value: detail, warnings: plan.warnings };
        },
      );
    },

    async list(query) {
      const parsed = listTicketsServiceQuerySchema.safeParse(query);
      if (!parsed.success) {
        return validationFailed(toTicketValidationIssues(parsed.error));
      }
      const { projectName, ...rest } = parsed.data;
      let projectPath: string | undefined;
      if (projectName !== undefined) {
        const resolved = await deps.resolveProjectPath(projectName);
        if (resolved === null) {
          logger.info("tickets.service.list.unknown_project", { projectName });
          return validationFailed([unknownProjectIssue(projectName)]);
        }
        projectPath = resolved;
      }
      const items = await deps.repo.list({ ...rest, projectPath });
      logger.debug("tickets.service.listed", {
        projectName,
        count: items.length,
      });
      return { ok: true, value: items };
    },

    async get(identity) {
      const parsed = ticketIdentitySchema.safeParse(identity);
      if (!parsed.success) {
        return validationFailed(toTicketValidationIssues(parsed.error));
      }
      const { projectName, number } = parsed.data;
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return ticketNotFound(projectName, number);
      }
      const detail = await deps.repo.find(projectPath, number);
      if (detail === null) {
        return ticketNotFound(projectName, number);
      }
      return { ok: true, value: detail };
    },

    async update(input) {
      const parsed = updateTicketServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.service.update.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return validationFailed(toTicketValidationIssues(parsed.error));
      }
      const { projectName, number, ...fields } = parsed.data;
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return ticketNotFound(projectName, number);
      }
      return deps.runProjectTicketOperation(projectPath, async () => {
        const detail = await deps.repo.update({
          ...fields,
          projectPath,
          number,
          updatedAt: deps.now(),
        });
        if (detail === null) {
          return ticketNotFound(projectName, number);
        }
        logger.info("tickets.service.updated", {
          projectName,
          number,
          status: detail.status,
          workType: detail.workType,
        });
        await publishUpdatedChange(projectPath, projectName, number);
        return { ok: true, value: detail };
      });
    },

    async delete(identity) {
      const parsed = ticketIdentitySchema.safeParse(identity);
      if (!parsed.success) {
        return validationFailed(toTicketValidationIssues(parsed.error));
      }
      const { projectName, number } = parsed.data;
      const projectPath = await deps.resolveProjectPath(projectName);
      if (projectPath === null) {
        return ticketNotFound(projectName, number);
      }
      return deps.runProjectTicketOperation(projectPath, async () => {
        const deleted = await deps.runTicketOperation(
          ticketOperationKey(projectPath, number),
          () => deps.repo.delete(projectPath, number),
        );
        if (deleted === null) {
          return ticketNotFound(projectName, number);
        }
        try {
          await deps.deleteTicketContent(deleted.id);
        } catch (error) {
          logger.warn("tickets.service.content_cleanup_failed", {
            projectName,
            number,
            orphanPathKey: deleted.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        logger.info("tickets.service.deleted", { projectName, number });
        publishChange("deleted", projectName, number, null);
        return { ok: true, value: deleted };
      });
    },
  };
}
