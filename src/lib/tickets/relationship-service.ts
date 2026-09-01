import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { TicketRelationshipStoreError } from "@/lib/state-store/ticket-relationships-store";
import type {
  AddTicketRelationshipRepoInput,
  TicketRelationshipListInput,
  TicketRelationshipMutationResult,
  TicketRelationshipRemovalResult,
  UpdateTicketRelationshipRepoInput,
  RemoveTicketRelationshipRepoInput,
} from "@/lib/state-store/tickets-repo";
import type { TicketProjectOperationContext } from "./project-operation-gate";
import { publishTicketChange } from "./events";
import { ticketOperationKey } from "./operation-lock";
import { formatTicketIdentifier } from "./references";
import { normalizeRelationshipDirection } from "./relationship-semantics";
import {
  RELATIONSHIP_CYCLE_RATIONALE,
  RELATIONSHIP_DUPLICATE_RATIONALE,
  RELATIONSHIP_SCOPE_RATIONALE,
  RELATIONSHIP_SELF_LINK_RATIONALE,
  ticketIdentitySchema,
  ticketRelationshipDescriptionSchema,
  ticketRelationshipRoleSchema,
  type TicketDetail,
  type TicketError,
  type TicketIdentity,
  type TicketListItem,
  type TicketRelationshipDeleteResponse,
  type TicketRelationshipMutationResponse,
  type TicketRelationshipPage,
  type TicketRelationshipView,
  type TicketResult,
} from "./schemas";
import {
  decodeTicketKeysetCursor,
  normalizeTicketPageLimit,
} from "./ticket-keyset-cursor";

const logger = createLogger("tickets.relationships");

const relationshipIdentityFields = {
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  relationshipId: z.string().min(1),
};

export const listTicketRelationshipsServiceInputSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
    role: ticketRelationshipRoleSchema.optional(),
    limit: z.number().int().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListTicketRelationshipsServiceInput = z.input<
  typeof listTicketRelationshipsServiceInputSchema
>;

export const getTicketRelationshipServiceInputSchema = z
  .object(relationshipIdentityFields)
  .strict();
export type GetTicketRelationshipServiceInput = z.input<
  typeof getTicketRelationshipServiceInputSchema
>;

export const addTicketRelationshipServiceInputSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
    target: ticketIdentitySchema.strict(),
    role: ticketRelationshipRoleSchema,
    description: ticketRelationshipDescriptionSchema.optional(),
  })
  .strict();
export type AddTicketRelationshipServiceInput = z.input<
  typeof addTicketRelationshipServiceInputSchema
>;

export const updateTicketRelationshipServiceInputSchema = z
  .object({
    ...relationshipIdentityFields,
    description: ticketRelationshipDescriptionSchema,
  })
  .strict();
export type UpdateTicketRelationshipServiceInput = z.input<
  typeof updateTicketRelationshipServiceInputSchema
>;

export const removeTicketRelationshipServiceInputSchema =
  getTicketRelationshipServiceInputSchema;
export type RemoveTicketRelationshipServiceInput = z.input<
  typeof removeTicketRelationshipServiceInputSchema
>;

export interface TicketRelationshipService {
  list(
    input: ListTicketRelationshipsServiceInput,
  ): Promise<TicketResult<TicketRelationshipPage>>;
  get(
    input: GetTicketRelationshipServiceInput,
  ): Promise<TicketResult<TicketRelationshipView>>;
  add(
    input: AddTicketRelationshipServiceInput,
  ): Promise<TicketResult<TicketRelationshipMutationResponse>>;
  update(
    input: UpdateTicketRelationshipServiceInput,
  ): Promise<TicketResult<TicketRelationshipMutationResponse>>;
  remove(
    input: RemoveTicketRelationshipServiceInput,
  ): Promise<TicketResult<TicketRelationshipDeleteResponse>>;
}

export interface TicketRelationshipServiceRepo {
  find(projectPath: string, number: number): Promise<TicketDetail | null>;
  findListItem(
    projectPath: string,
    number: number,
  ): Promise<TicketListItem | null>;
  listRelationships(
    input: TicketRelationshipListInput,
  ): Promise<TicketRelationshipPage>;
  findRelationship(
    ticketId: string,
    relationshipId: string,
  ): Promise<TicketRelationshipView | null>;
  addRelationship(
    input: AddTicketRelationshipRepoInput,
  ): Promise<TicketRelationshipMutationResult>;
  updateRelationship(
    input: UpdateTicketRelationshipRepoInput,
  ): Promise<TicketRelationshipMutationResult | null>;
  removeRelationship(
    input: RemoveTicketRelationshipRepoInput,
  ): Promise<TicketRelationshipRemovalResult | null>;
}

export interface TicketRelationshipServiceDeps {
  repo: TicketRelationshipServiceRepo;
  resolveProjectPath(projectName: string): Promise<string | null>;
  runMultiProjectTicketOperation<T>(
    projectPaths: readonly string[],
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T>;
  runTicketOperation<T>(key: string, operation: () => Promise<T>): Promise<T>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

export function createTicketRelationshipService(
  deps: TicketRelationshipServiceDeps,
): TicketRelationshipService {
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

  function ticketNotFound<T>(identity: TicketIdentity): TicketResult<T> {
    return {
      ok: false,
      error: {
        code: "ticket_not_found",
        identifier: formatTicketIdentifier(
          identity.projectName,
          identity.number,
        ),
      },
    };
  }

  function relationshipNotFound<T>(
    identity: TicketIdentity,
    relationshipId: string,
  ): TicketResult<T> {
    return {
      ok: false,
      error: {
        code: "relationship_not_found",
        details: {
          identifier: formatTicketIdentifier(
            identity.projectName,
            identity.number,
          ),
          relationshipId,
        },
      },
    };
  }

  function logRejection(
    operation: string,
    identity: TicketIdentity,
    error: TicketError,
    relationshipId?: string,
  ): void {
    logger.info("tickets.relationships.request_rejected", {
      operation,
      projectName: identity.projectName,
      number: identity.number,
      ...(relationshipId === undefined ? {} : { relationshipId }),
      errorCode: error.code,
    });
    if (error.code === "relationship_cycle") {
      logger.info("tickets.relationships.cycle_refused", {
        operation,
        relationshipId,
        relationType: error.details.relationType,
        sourceProjectName: error.details.source.projectName,
        sourceTicketNumber: error.details.source.number,
        targetProjectName: error.details.target.projectName,
        targetTicketNumber: error.details.target.number,
      });
    }
  }

  async function resolveCandidatePath(
    identity: TicketIdentity,
  ): Promise<string | null> {
    return deps.resolveProjectPath(identity.projectName);
  }

  async function rereadTicket(
    identity: TicketIdentity,
    candidatePath: string,
  ): Promise<TicketDetail | null> {
    const currentPath = await deps.resolveProjectPath(identity.projectName);
    if (currentPath !== candidatePath) return null;
    return deps.repo.find(currentPath, identity.number);
  }

  async function withTicketLocks<T>(
    ticketKeys: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const orderedKeys = [...new Set(ticketKeys)].sort();
    async function acquire(index: number): Promise<T> {
      const key = orderedKeys[index];
      if (key === undefined) return operation();
      return deps.runTicketOperation(key, () => acquire(index + 1));
    }
    return acquire(0);
  }

  async function publishChangedTickets(tickets: TicketDetail[]): Promise<void> {
    for (const ticket of tickets) {
      try {
        const listItem = await deps.repo.findListItem(
          ticket.projectPath,
          ticket.number,
        );
        publishTicketChange({
          publish: deps.publish,
          logger,
          change: "relationships",
          projectName: ticket.projectName,
          ticketNumber: ticket.number,
          listItem,
          attachmentIndexChanged: false,
        });
      } catch (error) {
        logger.warn("tickets.relationships.event_preparation_failed", {
          projectName: ticket.projectName,
          number: ticket.number,
          ticketId: ticket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function identityForTicketId(
    ticketId: string,
    anchor: TicketDetail,
    target: TicketDetail,
  ): TicketIdentity {
    const ticket = ticketId === anchor.id ? anchor : target;
    return { projectName: ticket.projectName, number: ticket.number };
  }

  function mapStoreError(
    storeError: TicketRelationshipStoreError,
    anchor: TicketDetail,
    target: TicketDetail,
  ): TicketError {
    const failure = storeError.failure;
    if (failure.kind === "ticket_not_found") {
      const identity = identityForTicketId(failure.ticketId, anchor, target);
      return {
        code: "ticket_not_found",
        identifier: formatTicketIdentifier(
          identity.projectName,
          identity.number,
        ),
      };
    }
    if (failure.kind === "duplicate") {
      return {
        code: "relationship_conflict",
        details: {
          reason: "duplicate",
          relationshipId: failure.relationshipId,
        },
        rationale: RELATIONSHIP_DUPLICATE_RATIONALE,
      };
    }

    const source = identityForTicketId(failure.sourceTicketId, anchor, target);
    const targetIdentity = identityForTicketId(
      failure.targetTicketId,
      anchor,
      target,
    );
    if (failure.kind === "self_link") {
      return {
        code: "relationship_self_link",
        details: { source, target: targetIdentity },
        rationale: RELATIONSHIP_SELF_LINK_RATIONALE,
      };
    }
    if (failure.kind === "scope") {
      return {
        code: "relationship_scope",
        details: { source, target: targetIdentity },
        rationale: RELATIONSHIP_SCOPE_RATIONALE,
      };
    }
    return {
      code: "relationship_cycle",
      details: {
        relationType: failure.relationType,
        source,
        target: targetIdentity,
      },
      rationale: RELATIONSHIP_CYCLE_RATIONALE,
    };
  }

  async function resolveExistingRelationshipMutation<T>(input: {
    operation: "update" | "remove";
    identity: TicketIdentity;
    relationshipId: string;
    mutate(
      anchor: TicketDetail,
      relationship: TicketRelationshipView,
    ): Promise<TicketResult<T>>;
  }): Promise<TicketResult<T>> {
    const anchorPath = await resolveCandidatePath(input.identity);
    if (anchorPath === null) return ticketNotFound(input.identity);
    const preliminaryAnchor = await deps.repo.find(
      anchorPath,
      input.identity.number,
    );
    if (preliminaryAnchor === null) return ticketNotFound(input.identity);
    const preliminaryRelationship = await deps.repo.findRelationship(
      preliminaryAnchor.id,
      input.relationshipId,
    );
    if (preliminaryRelationship === null) {
      return relationshipNotFound(input.identity, input.relationshipId);
    }

    const targetIdentity: TicketIdentity = {
      projectName: preliminaryRelationship.otherTicket.projectName,
      number: preliminaryRelationship.otherTicket.number,
    };
    const targetPath = await resolveCandidatePath(targetIdentity);
    if (targetPath === null) return ticketNotFound(targetIdentity);

    return deps.runMultiProjectTicketOperation(
      [anchorPath, targetPath],
      async () =>
        withTicketLocks(
          [
            ticketOperationKey(anchorPath, input.identity.number),
            ticketOperationKey(targetPath, targetIdentity.number),
          ],
          async () => {
            const anchor = await rereadTicket(input.identity, anchorPath);
            if (anchor === null) return ticketNotFound(input.identity);
            const target = await rereadTicket(targetIdentity, targetPath);
            if (target === null) return ticketNotFound(targetIdentity);
            const relationship = await deps.repo.findRelationship(
              anchor.id,
              input.relationshipId,
            );
            if (
              relationship === null ||
              relationship.otherTicket.id !== target.id
            ) {
              return relationshipNotFound(input.identity, input.relationshipId);
            }
            return input.mutate(anchor, relationship);
          },
        ),
    );
  }

  return {
    async list(input) {
      const parsed = listTicketRelationshipsServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.relationships.list.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return invalidInput(parsed.error);
      }
      const identity = {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
      };
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
      const projectPath = await resolveCandidatePath(identity);
      if (projectPath === null) return ticketNotFound(identity);
      const ticket = await deps.repo.find(projectPath, identity.number);
      if (ticket === null) return ticketNotFound(identity);
      const page = await deps.repo.listRelationships({
        ticketId: ticket.id,
        limit,
        ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
        ...(parsed.data.cursor === undefined
          ? {}
          : { cursor: parsed.data.cursor }),
      });
      logger.debug("tickets.relationships.listed", {
        projectName: identity.projectName,
        number: identity.number,
        role: parsed.data.role,
        pageSize: limit,
        cursorPresent: parsed.data.cursor !== undefined,
        returnedCount: page.items.length,
        total: page.total,
      });
      return { ok: true, value: page };
    },

    async get(input) {
      const parsed = getTicketRelationshipServiceInputSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const identity = {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
      };
      const projectPath = await resolveCandidatePath(identity);
      if (projectPath === null) return ticketNotFound(identity);
      const ticket = await deps.repo.find(projectPath, identity.number);
      if (ticket === null) return ticketNotFound(identity);
      const relationship = await deps.repo.findRelationship(
        ticket.id,
        parsed.data.relationshipId,
      );
      if (relationship === null) {
        return relationshipNotFound(identity, parsed.data.relationshipId);
      }
      return { ok: true, value: relationship };
    },

    async add(input) {
      const parsed = addTicketRelationshipServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.relationships.add.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return invalidInput(parsed.error);
      }
      const anchorIdentity: TicketIdentity = {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
      };
      const targetIdentity = parsed.data.target;
      const [anchorPath, targetPath] = await Promise.all([
        resolveCandidatePath(anchorIdentity),
        resolveCandidatePath(targetIdentity),
      ]);
      if (anchorPath === null) return ticketNotFound(anchorIdentity);
      if (targetPath === null) return ticketNotFound(targetIdentity);

      return deps.runMultiProjectTicketOperation(
        [anchorPath, targetPath],
        async () =>
          withTicketLocks(
            [
              ticketOperationKey(anchorPath, anchorIdentity.number),
              ticketOperationKey(targetPath, targetIdentity.number),
            ],
            async () => {
              const anchor = await rereadTicket(anchorIdentity, anchorPath);
              if (anchor === null) return ticketNotFound(anchorIdentity);
              const target = await rereadTicket(targetIdentity, targetPath);
              if (target === null) return ticketNotFound(targetIdentity);
              const normalized = normalizeRelationshipDirection(
                { id: anchor.id, projectName: anchor.projectName },
                { id: target.id, projectName: target.projectName },
                parsed.data.role,
              );
              if (!normalized.ok) {
                const error: TicketError =
                  normalized.reason === "self_link"
                    ? {
                        code: "relationship_self_link",
                        details: {
                          source: anchorIdentity,
                          target: targetIdentity,
                        },
                        rationale: RELATIONSHIP_SELF_LINK_RATIONALE,
                      }
                    : {
                        code: "relationship_scope",
                        details: {
                          source: anchorIdentity,
                          target: targetIdentity,
                        },
                        rationale: RELATIONSHIP_SCOPE_RATIONALE,
                      };
                logRejection("add", anchorIdentity, error);
                return { ok: false, error };
              }

              let mutation: TicketRelationshipMutationResult;
              try {
                mutation = await deps.repo.addRelationship({
                  id: deps.generateId(),
                  anchorTicketId: anchor.id,
                  ...normalized.relationship,
                  description: parsed.data.description ?? "",
                  createdAt: deps.now(),
                });
              } catch (error) {
                if (!(error instanceof TicketRelationshipStoreError)) {
                  throw error;
                }
                const mapped = mapStoreError(error, anchor, target);
                logRejection("add", anchorIdentity, mapped);
                return { ok: false, error: mapped };
              }

              await publishChangedTickets(mutation.tickets);
              logger.info("tickets.relationships.added", {
                projectName: anchor.projectName,
                number: anchor.number,
                relationshipId: mutation.relationship.id,
                role: mutation.relationship.role,
                affectedTicketCount: mutation.tickets.length,
              });
              if (mutation.replacedRelationshipId !== null) {
                logger.info("tickets.relationships.reparented", {
                  projectName: anchor.projectName,
                  number: anchor.number,
                  relationshipId: mutation.relationship.id,
                  replacedRelationshipId: mutation.replacedRelationshipId,
                  affectedTicketCount: mutation.tickets.length,
                });
              }
              return {
                ok: true,
                value: {
                  relationship: mutation.relationship,
                  tickets: mutation.tickets,
                },
              };
            },
          ),
      );
    },

    async update(input) {
      const parsed =
        updateTicketRelationshipServiceInputSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const identity = {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
      };
      return resolveExistingRelationshipMutation({
        operation: "update",
        identity,
        relationshipId: parsed.data.relationshipId,
        async mutate(anchor) {
          const mutation = await deps.repo.updateRelationship({
            anchorTicketId: anchor.id,
            relationshipId: parsed.data.relationshipId,
            description: parsed.data.description,
            updatedAt: deps.now(),
          });
          if (mutation === null) {
            return relationshipNotFound(identity, parsed.data.relationshipId);
          }
          await publishChangedTickets(mutation.tickets);
          logger.info("tickets.relationships.updated", {
            projectName: identity.projectName,
            number: identity.number,
            relationshipId: mutation.relationship.id,
            affectedTicketCount: mutation.tickets.length,
          });
          return {
            ok: true,
            value: {
              relationship: mutation.relationship,
              tickets: mutation.tickets,
            },
          };
        },
      });
    },

    async remove(input) {
      const parsed =
        removeTicketRelationshipServiceInputSchema.safeParse(input);
      if (!parsed.success) return invalidInput(parsed.error);
      const identity = {
        projectName: parsed.data.projectName,
        number: parsed.data.number,
      };
      return resolveExistingRelationshipMutation({
        operation: "remove",
        identity,
        relationshipId: parsed.data.relationshipId,
        async mutate(anchor) {
          const mutation = await deps.repo.removeRelationship({
            anchorTicketId: anchor.id,
            relationshipId: parsed.data.relationshipId,
            updatedAt: deps.now(),
          });
          if (mutation === null) {
            return relationshipNotFound(identity, parsed.data.relationshipId);
          }
          await publishChangedTickets(mutation.tickets);
          logger.info("tickets.relationships.removed", {
            projectName: identity.projectName,
            number: identity.number,
            relationshipId: mutation.relationshipId,
            affectedTicketCount: mutation.tickets.length,
          });
          return {
            ok: true,
            value: {
              relationshipId: mutation.relationshipId,
              tickets: mutation.tickets,
            },
          };
        },
      });
    },
  };
}
