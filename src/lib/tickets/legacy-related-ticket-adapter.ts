import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import { createLogger } from "@/lib/logging";
import type { TicketRelationshipService } from "./relationship-service";
import type { TicketService } from "./service";
import {
  legacyDeletedRelatedTicketAttachmentSchema,
  legacyRelatedTicketAttachmentSchema,
  legacyResolvedRelatedTicketSchema,
  type LegacyDeletedRelatedTicketAttachment,
  type LegacyRelatedTicketAttachment,
  type LegacyResolvedRelatedTicket,
} from "./legacy-related-ticket-wire";
import { formatTicketIdentifier } from "./references";
import { ticketFollowCommand } from "./attachment-commands";
import type {
  TicketDetail,
  TicketError,
  TicketRelationshipView,
} from "./schemas";
import type { TicketIdentity, TicketResult } from "./schemas";

const logger = createLogger("tickets.legacy-related-ticket");

export interface LegacyRelatedTicketIdentity extends TicketIdentity {
  attachmentId: string;
}

export interface AddLegacyRelatedTicketInput extends TicketIdentity {
  description: string;
  target: TicketIdentity;
}

export interface LegacyRelatedTicketAdapter {
  add(
    input: AddLegacyRelatedTicketInput,
  ): Promise<TicketResult<LegacyRelatedTicketAttachment>>;
  resolve(
    input: LegacyRelatedTicketIdentity,
  ): Promise<TicketResult<LegacyResolvedRelatedTicket>>;
  update(
    input: LegacyRelatedTicketIdentity & { description: string },
  ): Promise<TicketResult<LegacyRelatedTicketAttachment>>;
  remove(
    input: LegacyRelatedTicketIdentity,
  ): Promise<TicketResult<LegacyDeletedRelatedTicketAttachment>>;
  isRelationshipHandle(
    input: LegacyRelatedTicketIdentity,
  ): Promise<TicketResult<boolean>>;
}

export interface LegacyRelatedTicketAdapterDeps {
  repo: Pick<TicketsRepo, "resolveLegacyRelationship">;
  ticketService: Pick<TicketService, "get">;
  relationshipService: TicketRelationshipService;
}

export function createLegacyRelatedTicketAdapter(
  deps: LegacyRelatedTicketAdapterDeps,
): LegacyRelatedTicketAdapter {
  interface ResolvedHandle {
    anchor: TicketDetail;
    relationship: TicketRelationshipView;
  }

  function attachmentNotFound<T>(
    input: LegacyRelatedTicketIdentity,
  ): TicketResult<T> {
    return {
      ok: false,
      error: {
        code: "attachment_not_found",
        identifier: formatTicketIdentifier(input.projectName, input.number),
        attachmentId: input.attachmentId,
      },
    };
  }

  function attachmentFor(
    requestedId: string,
    anchor: TicketDetail,
    relationship: TicketRelationshipView,
  ): LegacyRelatedTicketAttachment {
    const otherIdentifier = formatTicketIdentifier(
      relationship.otherTicket.projectName,
      relationship.otherTicket.number,
    );
    return legacyRelatedTicketAttachmentSchema.parse({
      id: requestedId,
      ticketId: anchor.id,
      description:
        relationship.description.trim() === ""
          ? "Related ticket"
          : relationship.description,
      payload: {
        kind: "related_ticket",
        ticketId: relationship.otherTicket.id,
        identifierSnapshot: otherIdentifier,
      },
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    });
  }

  async function resolveHandle(
    input: LegacyRelatedTicketIdentity,
  ): Promise<TicketResult<ResolvedHandle | null>> {
    const anchorResult = await deps.ticketService.get(input);
    if (!anchorResult.ok) return anchorResult;
    const direct = await deps.relationshipService.get({
      projectName: input.projectName,
      number: input.number,
      relationshipId: input.attachmentId,
    });
    if (direct.ok) {
      return {
        ok: true,
        value: { anchor: anchorResult.value, relationship: direct.value },
      };
    }
    if (direct.error.code !== "relationship_not_found") return direct;
    const aliased = await deps.repo.resolveLegacyRelationship(
      anchorResult.value.id,
      input.attachmentId,
    );
    return {
      ok: true,
      value:
        aliased === null
          ? null
          : { anchor: anchorResult.value, relationship: aliased },
    };
  }

  function errorResult<T>(error: TicketError): TicketResult<T> {
    return { ok: false, error };
  }

  return {
    async add(input) {
      const mutation = await deps.relationshipService.add({
        projectName: input.projectName,
        number: input.number,
        target: input.target,
        role: "related",
        description: input.description,
      });
      if (!mutation.ok) return mutation;
      const anchor = mutation.value.tickets.find(
        (ticket) =>
          ticket.projectName === input.projectName &&
          ticket.number === input.number,
      );
      if (anchor === undefined) {
        const reread = await deps.ticketService.get(input);
        if (!reread.ok) return reread;
        const attachment = attachmentFor(
          mutation.value.relationship.id,
          reread.value,
          mutation.value.relationship,
        );
        logger.info("tickets.legacy-related-ticket.added", {
          projectName: input.projectName,
          number: input.number,
          relationshipId: mutation.value.relationship.id,
        });
        return { ok: true, value: attachment };
      }
      const attachment = attachmentFor(
        mutation.value.relationship.id,
        anchor,
        mutation.value.relationship,
      );
      logger.info("tickets.legacy-related-ticket.added", {
        projectName: input.projectName,
        number: input.number,
        relationshipId: mutation.value.relationship.id,
      });
      return { ok: true, value: attachment };
    },

    async resolve(input) {
      const found = await resolveHandle(input);
      if (!found.ok) return errorResult(found.error);
      if (found.value === null) return attachmentNotFound(input);
      const { anchor, relationship } = found.value;
      const attachment = attachmentFor(
        input.attachmentId,
        anchor,
        relationship,
      );
      const targetIdentity = {
        projectName: relationship.otherTicket.projectName,
        number: relationship.otherTicket.number,
      };
      const target = await deps.ticketService.get(targetIdentity);
      const identifierSnapshot = formatTicketIdentifier(
        targetIdentity.projectName,
        targetIdentity.number,
      );
      const value = target.ok
        ? legacyResolvedRelatedTicketSchema.parse({
            kind: "related_ticket",
            attachment,
            available: true,
            ticket: target.value,
            followCommand: ticketFollowCommand(identifierSnapshot),
          })
        : legacyResolvedRelatedTicketSchema.parse({
            kind: "related_ticket",
            attachment,
            available: false,
            identifierSnapshot,
          });
      logger.debug("tickets.legacy-related-ticket.resolved", {
        projectName: input.projectName,
        number: input.number,
        requestedId: input.attachmentId,
        relationshipId: relationship.id,
        targetAvailable: target.ok,
      });
      return { ok: true, value };
    },

    async update(input) {
      const found = await resolveHandle(input);
      if (!found.ok) return errorResult(found.error);
      if (found.value === null) return attachmentNotFound(input);
      const mutation = await deps.relationshipService.update({
        projectName: input.projectName,
        number: input.number,
        relationshipId: found.value.relationship.id,
        description: input.description,
      });
      if (!mutation.ok) return mutation;
      const anchor =
        mutation.value.tickets.find(
          (ticket) => ticket.id === found.value?.anchor.id,
        ) ?? found.value.anchor;
      const attachment = attachmentFor(
        input.attachmentId,
        anchor,
        mutation.value.relationship,
      );
      logger.info("tickets.legacy-related-ticket.updated", {
        projectName: input.projectName,
        number: input.number,
        requestedId: input.attachmentId,
        relationshipId: mutation.value.relationship.id,
      });
      return { ok: true, value: attachment };
    },

    async remove(input) {
      const found = await resolveHandle(input);
      if (!found.ok) return errorResult(found.error);
      if (found.value === null) return attachmentNotFound(input);
      const mutation = await deps.relationshipService.remove({
        projectName: input.projectName,
        number: input.number,
        relationshipId: found.value.relationship.id,
      });
      if (!mutation.ok) return mutation;
      const anchor = mutation.value.tickets.find(
        (ticket) => ticket.id === found.value?.anchor.id,
      );
      const value = legacyDeletedRelatedTicketAttachmentSchema.parse({
        attachmentId: input.attachmentId,
        ticketId: found.value.anchor.id,
        kind: "related_ticket",
        ticketUpdatedAt: anchor?.updatedAt ?? found.value.anchor.updatedAt,
      });
      logger.info("tickets.legacy-related-ticket.removed", {
        projectName: input.projectName,
        number: input.number,
        requestedId: input.attachmentId,
        relationshipId: found.value.relationship.id,
      });
      return { ok: true, value };
    },

    async isRelationshipHandle(input) {
      const found = await resolveHandle(input);
      if (!found.ok) return errorResult(found.error);
      return { ok: true, value: found.value !== null };
    },
  };
}
