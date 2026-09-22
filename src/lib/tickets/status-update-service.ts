import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type {
  TicketStatusUpdateListInput,
  TicketStatusUpdateMutationResult,
} from "@/lib/state-store/tickets-repo";
import type { TicketProjectOperationContext } from "./project-operation-gate";
import { publishTicketChange } from "./events";
import { ticketOperationKey } from "./operation-lock";
import { formatTicketIdentifier } from "./references";
import {
  ticketStatusUpdateAuthorSchema,
  ticketStatusUpdateBodySchema,
  type TicketDetail,
  type TicketListItem,
  type TicketResult,
  type TicketStatusUpdate,
  type TicketStatusUpdateCreateResponse,
  type TicketStatusUpdatePage,
} from "./schemas";
import {
  decodeTicketKeysetCursor,
  normalizeTicketPageLimit,
} from "./ticket-keyset-cursor";

const logger = createLogger("tickets.status-updates");

const statusUpdateTicketIdentityFields = {
  projectName: z.string().min(1),
  number: z.number().int().positive(),
};

export const listTicketStatusUpdatesServiceInputSchema = z
  .object({
    ...statusUpdateTicketIdentityFields,
    limit: z.number().int().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListTicketStatusUpdatesServiceInput = z.input<
  typeof listTicketStatusUpdatesServiceInputSchema
>;

export const getTicketStatusUpdateServiceInputSchema = z
  .object({
    ...statusUpdateTicketIdentityFields,
    updateId: z.string().min(1),
  })
  .strict();
export type GetTicketStatusUpdateServiceInput = z.input<
  typeof getTicketStatusUpdateServiceInputSchema
>;

export const postTicketStatusUpdateServiceInputSchema = z
  .object({
    ...statusUpdateTicketIdentityFields,
    bodyMarkdown: ticketStatusUpdateBodySchema,
    author: ticketStatusUpdateAuthorSchema,
  })
  .strict();
export type PostTicketStatusUpdateServiceInput = z.input<
  typeof postTicketStatusUpdateServiceInputSchema
>;

export interface TicketStatusUpdateService {
  list(
    input: ListTicketStatusUpdatesServiceInput,
  ): Promise<TicketResult<TicketStatusUpdatePage>>;
  get(
    input: GetTicketStatusUpdateServiceInput,
  ): Promise<TicketResult<TicketStatusUpdate | null>>;
  post(
    input: PostTicketStatusUpdateServiceInput,
  ): Promise<TicketResult<TicketStatusUpdateCreateResponse>>;
}

export interface TicketStatusUpdateServiceRepo {
  find(projectPath: string, number: number): Promise<TicketDetail | null>;
  findListItem(
    projectPath: string,
    number: number,
  ): Promise<TicketListItem | null>;
  listStatusUpdates(
    input: TicketStatusUpdateListInput,
  ): Promise<TicketStatusUpdatePage>;
  findStatusUpdate(
    ticketId: string,
    updateId: string,
  ): Promise<TicketStatusUpdate | null>;
  addStatusUpdate(
    update: TicketStatusUpdate,
  ): Promise<TicketStatusUpdateMutationResult>;
}

export interface TicketStatusUpdateServiceDeps {
  repo: TicketStatusUpdateServiceRepo;
  resolveProjectPath(projectName: string): Promise<string | null>;
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T>;
  runTicketOperation<T>(key: string, operation: () => Promise<T>): Promise<T>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

export function createTicketStatusUpdateService(
  deps: TicketStatusUpdateServiceDeps,
): TicketStatusUpdateService {
  function validationFailed<T>(
    issues: Array<{ path: string; message: string }>,
  ): TicketResult<T> {
    return { ok: false, error: { code: "validation_failed", issues } };
  }

  function invalidInput<T>(error: z.ZodError): TicketResult<T> {
    return validationFailed(
      error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  function ticketNotFound<T>(
    projectName: string,
    number: number,
  ): TicketResult<T> {
    return {
      ok: false,
      error: {
        code: "ticket_not_found",
        identifier: formatTicketIdentifier(projectName, number),
      },
    };
  }

  async function resolveTicket(
    projectName: string,
    number: number,
  ): Promise<TicketResult<TicketDetail>> {
    const projectPath = await deps.resolveProjectPath(projectName);
    if (projectPath === null) return ticketNotFound(projectName, number);
    const detail = await deps.repo.find(projectPath, number);
    return detail === null
      ? ticketNotFound(projectName, number)
      : { ok: true, value: detail };
  }

  async function publishStatusUpdatesChanged(
    ticket: TicketDetail,
  ): Promise<void> {
    try {
      const listItem = await deps.repo.findListItem(
        ticket.projectPath,
        ticket.number,
      );
      publishTicketChange({
        publish: deps.publish,
        logger,
        change: "status_updates",
        projectName: ticket.projectName,
        ticketNumber: ticket.number,
        listItem,
        attachmentIndexChanged: false,
      });
    } catch (error) {
      logger.warn("tickets.status_updates.event_preparation_failed", {
        projectName: ticket.projectName,
        number: ticket.number,
        ticketId: ticket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async list(input) {
      const parsed = listTicketStatusUpdatesServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.status_updates.list.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return invalidInput(parsed.error);
      }
      const limit = normalizeTicketPageLimit(parsed.data.limit);
      if (limit === null) {
        return validationFailed([
          {
            path: "limit",
            message: "limit must be an integer from 1 through 100",
          },
        ]);
      }
      if (
        parsed.data.cursor !== undefined &&
        decodeTicketKeysetCursor(parsed.data.cursor) === null
      ) {
        return validationFailed([
          {
            path: "cursor",
            message: "cursor must be a valid ticket keyset cursor",
          },
        ]);
      }
      const resolved = await resolveTicket(
        parsed.data.projectName,
        parsed.data.number,
      );
      if (!resolved.ok) return resolved;
      const page = await deps.repo.listStatusUpdates({
        ticketId: resolved.value.id,
        limit,
        ...(parsed.data.cursor === undefined
          ? {}
          : { cursor: parsed.data.cursor }),
      });
      logger.debug("tickets.status_updates.listed", {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
        pageSize: limit,
        cursorPresent: parsed.data.cursor !== undefined,
        returnedCount: page.items.length,
        total: page.total,
      });
      return { ok: true, value: page };
    },

    async get(input) {
      const parsed = getTicketStatusUpdateServiceInputSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const resolved = await resolveTicket(
        parsed.data.projectName,
        parsed.data.number,
      );
      if (!resolved.ok) return resolved;
      const update = await deps.repo.findStatusUpdate(
        resolved.value.id,
        parsed.data.updateId,
      );
      return { ok: true, value: update };
    },

    async post(input) {
      const parsed = postTicketStatusUpdateServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.status_updates.post.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return invalidInput(parsed.error);
      }
      const candidatePath = await deps.resolveProjectPath(
        parsed.data.projectName,
      );
      if (candidatePath === null) {
        return ticketNotFound(parsed.data.projectName, parsed.data.number);
      }

      return deps.runProjectTicketOperation(candidatePath, async () =>
        deps.runTicketOperation(
          ticketOperationKey(candidatePath, parsed.data.number),
          async () => {
            const currentPath = await deps.resolveProjectPath(
              parsed.data.projectName,
            );
            if (currentPath !== candidatePath) {
              return ticketNotFound(
                parsed.data.projectName,
                parsed.data.number,
              );
            }
            const ticket = await deps.repo.find(
              currentPath,
              parsed.data.number,
            );
            if (ticket === null) {
              return ticketNotFound(
                parsed.data.projectName,
                parsed.data.number,
              );
            }
            const mutation = await deps.repo.addStatusUpdate({
              id: deps.generateId(),
              ticketId: ticket.id,
              bodyMarkdown: parsed.data.bodyMarkdown,
              author: parsed.data.author,
              createdAt: deps.now(),
            });
            await publishStatusUpdatesChanged(mutation.ticket);
            logger.info("tickets.status_updates.posted", {
              projectName: mutation.ticket.projectName,
              number: mutation.ticket.number,
              ticketId: mutation.ticket.id,
              updateId: mutation.update.id,
              authorKind: mutation.update.author.kind,
            });
            return {
              ok: true,
              value: {
                update: mutation.update,
                ticket: mutation.ticket,
              },
            };
          },
        ),
      );
    },
  };
}
