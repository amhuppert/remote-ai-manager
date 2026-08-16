import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import { createLogger } from "@/lib/logging";
import type { GraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import {
  computeSpecElementPayloadHash,
  type SpecsRepo,
} from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import type { TicketContentStore } from "@/lib/tickets/content-store";
import type {
  TicketAttachment,
  TicketDetail,
  TicketIdentity,
  TicketResult,
  TicketStatus,
  TicketWorkType,
  UpdateTicketFields,
} from "@/lib/tickets/schemas";

import {
  continueOrdinaryAuthoring,
  type AuthoringService,
  type AuthoringSpecResult,
} from "./authoring-service";
import type { SpecEventsPublisher } from "./events";
import { isEarlierMergedDelivery } from "./delivery-history";
import { findDeliveryVerdictForExecution } from "./delivery-verdict-identity";
import { formatElementHandle, parseSpecSlug } from "./handles";
import { openDraftAuthoringStage } from "./transitions";
import {
  projectSpecPhase,
  projectTaskWorkStatus,
  type SpecPhaseProjection,
} from "./phase";
import {
  actorProvenanceSchema,
  specGatePolicySchema,
  type ActorProvenance,
  type Spec,
  type SpecLinkCategory,
  type SpecLinkObjectKind,
  type SpecLinkRow,
  type SpecRevision,
  type SpecRevisionSnapshot,
  type TaskElementPayload,
} from "./schemas";

const logger = createLogger("specs.links-service");

const conversationIdentitySchema = z
  .object({
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .strict();

export const promoteConversationInputSchema = z
  .object({
    projectPath: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    conversation: conversationIdentitySchema,
    messageIds: z.array(z.string().min(1)).min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type PromoteConversationInput = z.infer<
  typeof promoteConversationInputSchema
>;

export const graduateTicketInputSchema = z
  .object({
    ticket: z
      .object({
        projectName: z.string().min(1),
        number: z.number().int().positive(),
      })
      .strict(),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type GraduateTicketInput = z.infer<typeof graduateTicketInputSchema>;

export const materializeApprovedTasksInputSchema = z
  .object({
    specId: z.string().min(1),
    projectName: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type MaterializeApprovedTasksInput = z.infer<
  typeof materializeApprovedTasksInputSchema
>;

export const linkTicketInputSchema = z
  .object({
    specId: z.string().min(1),
    ticket: z
      .object({
        projectName: z.string().min(1),
        number: z.number().int().positive(),
      })
      .strict(),
    elementIds: z.array(z.string().min(1)).optional(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type LinkTicketInput = z.infer<typeof linkTicketInputSchema>;

export const ticketReadThroughInputSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
  })
  .strict();
export type TicketReadThroughInput = z.infer<
  typeof ticketReadThroughInputSchema
>;

export const specLinkedTicketsInputSchema = z
  .object({ specId: z.string().min(1) })
  .strict();
export type SpecLinkedTicketsInput = z.infer<
  typeof specLinkedTicketsInputSchema
>;

export type SourceTaskState = "current" | "removed" | "changed";

export interface LinkedTaskReadThrough {
  readonly taskElementId: string;
  /**
   * Bare spec handle ("T7") derived from the immutable element counter; null
   * only when the element row is unavailable, in which case surfaces fall
   * back to the raw element id.
   */
  readonly taskHandle: string | null;
  readonly sourceTaskState: SourceTaskState;
  readonly workStatus: ReturnType<typeof projectTaskWorkStatus>["status"];
}

export interface LinkedSpecReadThrough {
  readonly specId: string;
  readonly slug: string;
  readonly name: string;
  readonly revision: number;
  readonly phase: SpecPhaseProjection;
  readonly criteriaProgress: {
    readonly proven: number;
    readonly total: number;
  };
  readonly linkedTasks: LinkedTaskReadThrough[];
}

export interface TicketReadThrough {
  readonly ticket: TicketDetail;
  readonly specs: LinkedSpecReadThrough[];
}

export interface LinkedTicketReadThrough {
  readonly projectName: string;
  readonly number: number;
  readonly title: string;
}

export interface ConversationSource {
  readonly messages: Array<{
    readonly id: string;
    readonly role: "user" | "assistant" | "notice";
    readonly content: MessageContentBlock[];
  }>;
  readonly attachments: Array<{
    readonly id: string;
    readonly version: string;
    readonly fileName: string;
    readonly bytes: Uint8Array;
  }>;
}

export interface ResolvedTicketAttachmentSource {
  readonly content: string;
  readonly version: string;
  readonly contentHash: string;
}

interface MaterializedTicketInput {
  projectName: string;
  title: string;
  description: string;
  workType: TicketWorkType;
  status: TicketStatus;
}

interface LinkedTicketService {
  get(identity: TicketIdentity): Promise<TicketResult<TicketDetail>>;
  create(input: MaterializedTicketInput): Promise<TicketResult<TicketDetail>>;
  update?(
    input: TicketIdentity & UpdateTicketFields,
  ): Promise<TicketResult<TicketDetail>>;
}

export interface LinksServiceDeps {
  specs: SpecsRepo;
  links: SpecLinksRepo;
  delivery: SpecDeliveryRepo;
  executionBindings: Pick<SpecExecutionBindingRepo, "findBySpecExecutionId">;
  authoring: Pick<AuthoringService, "createSpec" | "upsertDraftElement">;
  events: SpecEventsPublisher;
  workflowEvents: Pick<GraphWorkflowEventsRepo, "findByExecution">;
  tickets: LinkedTicketService;
  contentStore: Pick<TicketContentStore, "capture" | "captureText">;
  loadConversationSource(
    conversation: z.infer<typeof conversationIdentitySchema>,
  ): Promise<ConversationSource>;
  resolveTicketAttachment(
    ticket: TicketDetail,
    attachment: TicketAttachment,
  ): Promise<ResolvedTicketAttachmentSource>;
  newId?(prefix: string): string;
  now?(): string;
}

export interface LinksService {
  promoteConversation(
    input: PromoteConversationInput,
  ): Promise<AuthoringSpecResult>;
  graduateTicket(input: GraduateTicketInput): Promise<AuthoringSpecResult>;
  materializeApprovedTasks(
    input: MaterializeApprovedTasksInput,
  ): Promise<TicketDetail[]>;
  linkTicket(input: LinkTicketInput): Promise<SpecLinkRow>;
  getTicketReadThrough(
    input: TicketReadThroughInput,
  ): Promise<TicketReadThrough>;
  getSpecLinkedTickets(
    input: SpecLinkedTicketsInput,
  ): Promise<LinkedTicketReadThrough[]>;
}

export class LinksServiceError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_source" | "ticket_operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "LinksServiceError";
  }
}

interface LinkEventInput {
  readonly spec: Spec;
  readonly link: SpecLinkRow;
  readonly actor: ActorProvenance;
  readonly occurredAt: string;
}

interface MaterializedTaskSnapshot {
  readonly approvedRevisionId: string;
  readonly taskElementId: string;
  readonly taskPayloadHash: string;
}

interface EntryReservation {
  readonly result: AuthoringSpecResult;
  readonly link: SpecLinkRow;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ticketObjectRef(
  ticket: Pick<TicketDetail, "id" | "projectName" | "number">,
): string {
  return stableStringify({
    ticketId: ticket.id,
    projectName: ticket.projectName,
    number: ticket.number,
  });
}

function conversationObjectRef(
  conversation: z.infer<typeof conversationIdentitySchema>,
): string {
  return stableStringify(conversation);
}

function parseTicketObjectRef(objectRefJson: string): TicketIdentity {
  const parsed = z
    .object({
      ticketId: z.string().min(1),
      projectName: z.string().min(1),
      number: z.number().int().positive(),
    })
    .parse(JSON.parse(objectRefJson));
  return { projectName: parsed.projectName, number: parsed.number };
}

function parseElementIds(link: SpecLinkRow): string[] {
  if (link.element_ids_json === null) return [];
  return z.array(z.string().min(1)).parse(JSON.parse(link.element_ids_json));
}

function parseMaterializedSnapshot(
  link: SpecLinkRow,
): MaterializedTaskSnapshot | null {
  if (link.snapshot_json === null) return null;
  const parsed = z
    .object({
      approvedRevisionId: z.string().min(1),
      taskElementId: z.string().min(1),
      taskPayloadHash: z.string().min(1),
    })
    .safeParse(JSON.parse(link.snapshot_json));
  return parsed.success ? parsed.data : null;
}

function requireTicket<T>(result: TicketResult<T>): T {
  if (result.ok) return result.value;
  throw new LinksServiceError(
    result.error.code === "ticket_not_found"
      ? "not_found"
      : "ticket_operation_failed",
    `ticket operation failed: ${result.error.code}`,
  );
}

function latestRevision(
  revisions: readonly SpecRevision[],
): SpecRevision | null {
  return revisions.at(-1) ?? null;
}

function taskPayload(
  snapshot: SpecRevisionSnapshot,
  taskElementId: string,
): TaskElementPayload | null {
  const version = snapshot.elements.find(
    ({ element }) => element.id === taskElementId && element.kind === "task",
  )?.version;
  return version?.payload.kind === "task" ? version.payload : null;
}

export function createLinksService(deps: LinksServiceDeps): LinksService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());
  const entryPathOperations = new Map<string, Promise<AuthoringSpecResult>>();

  function runEntryPath(
    key: string,
    operation: () => Promise<AuthoringSpecResult>,
  ): Promise<AuthoringSpecResult> {
    const running = entryPathOperations.get(key);
    if (running !== undefined) return running;

    const started = operation();
    entryPathOperations.set(key, started);
    const clear = () => {
      if (entryPathOperations.get(key) === started) {
        entryPathOperations.delete(key);
      }
    };
    void started.then(clear, clear);
    return started;
  }

  function prepareLinkEvent(input: LinkEventInput) {
    return deps.events.appendInTransaction({
      actor: input.actor,
      durableEventType: "spec-changed",
      durablePayload: {
        kind: "link-changed",
        linkId: input.link.id,
        category: input.link.category,
        objectKind: input.link.object_kind,
      },
      sseEvent: {
        type: "spec-changed",
        kind: "link-changed",
        projectPath: input.spec.projectPath,
        specId: input.spec.id,
        specSlug: input.spec.slug,
        occurredAt: input.occurredAt,
        ...(input.link.element_ids_json === null
          ? {}
          : { elementIds: parseElementIds(input.link) }),
      },
    });
  }

  function prepareEntryDraftEvent(
    spec: Spec,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
    kind: "spec-created" | "amendment-opened",
  ) {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-changed",
      durablePayload: { kind, revisionId },
      sseEvent: {
        type: "spec-changed",
        kind: "draft-opened",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
      },
    });
  }

  async function reserveEntry(input: {
    projectPath: string;
    slug: string;
    name: string;
    gatePolicy: PromoteConversationInput["gatePolicy"];
    actor: ActorProvenance;
    objectKind: Extract<SpecLinkObjectKind, "conversation" | "ticket">;
    objectRefJson: string;
    category: Extract<SpecLinkCategory, "source" | "graduated_from">;
  }): Promise<EntryReservation> {
    const occurredAt = now();
    const transaction = await deps.specs.transaction(
      "links.reserve-entry",
      (repo) => {
        const existingLink = deps.links
          .findByLinkedObject(input.objectKind, input.objectRefJson)
          .find((candidate) => candidate.category === input.category);
        if (existingLink !== undefined) {
          const spec = repo.findById(existingLink.spec_id);
          const revision = latestRevision(
            repo.listRevisions(existingLink.spec_id),
          );
          if (spec === null || revision === null) {
            throw new LinksServiceError(
              "not_found",
              `linked spec ${existingLink.spec_id} is unavailable`,
            );
          }
          return {
            value: {
              result: { spec, draft: revision, reused: true },
              link: existingLink,
            } satisfies EntryReservation,
            prepared: [],
          };
        }

        const resolved = repo.resolve(input.projectPath, input.slug);
        let spec: Spec;
        let draft: SpecRevision;
        let reused: boolean;
        let draftEventKind: "spec-created" | "amendment-opened" | null;
        if (resolved === null) {
          const created = repo.create({
            spec: {
              id: newId("spec"),
              projectPath: input.projectPath,
              slug: input.slug,
              name: input.name,
              gatePolicy: input.gatePolicy,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
            initialRevision: {
              id: newId("revision"),
              authoringStage: openDraftAuthoringStage({
                policy: input.gatePolicy,
              }),
              createdAt: occurredAt,
            },
          });
          spec = created.spec;
          draft = created.revision;
          reused = false;
          draftEventKind = "spec-created";
        } else {
          spec = resolved;
          const continuation = continueOrdinaryAuthoring(repo, spec.id);
          if (continuation.kind === "reuse_draft") {
            draft = continuation.draft;
            reused = true;
            draftEventKind = null;
          } else {
            if (continuation.kind === "unavailable") {
              throw new LinksServiceError(
                "not_found",
                `spec ${spec.id} has no reusable revision`,
              );
            }
            const approved = continuation.approved;
            draft = repo.createDraftFromBase({
              id: newId("revision"),
              specId: spec.id,
              baseRevisionId: approved.id,
              authoringStage: openDraftAuthoringStage({
                policy: spec.gatePolicy,
                baseRevision: {
                  state: "approved",
                  authoringStage: approved.authoringStage,
                },
              }),
              createdAt: occurredAt,
            });
            reused = false;
            draftEventKind = "amendment-opened";
          }
        }

        const link: SpecLinkRow = {
          id: newId("spec-link"),
          spec_id: spec.id,
          object_kind: input.objectKind,
          object_ref_json: input.objectRefJson,
          direction: "inbound",
          category: input.category,
          snapshot_json: null,
          element_ids_json: null,
          actor_json: stableStringify(input.actor),
          created_at: occurredAt,
        };
        deps.links.insertLink(link);
        return {
          value: {
            result: { spec, draft, reused },
            link,
          } satisfies EntryReservation,
          prepared: [
            ...(draftEventKind === null
              ? []
              : [
                  prepareEntryDraftEvent(
                    spec,
                    draft.id,
                    input.actor,
                    occurredAt,
                    draftEventKind,
                  ),
                ]),
            prepareLinkEvent({
              spec,
              link,
              actor: input.actor,
              occurredAt,
            }),
          ],
        };
      },
    );
    for (const prepared of transaction.prepared) {
      deps.events.publishAfterCommit(prepared);
    }
    return transaction.value;
  }

  async function completeEntry(
    reservation: EntryReservation,
    snapshotJson: string,
    actor: ActorProvenance,
  ): Promise<void> {
    const completedLink: SpecLinkRow = {
      ...reservation.link,
      snapshot_json: snapshotJson,
    };
    const prepared = await deps.specs.transaction(
      "links.complete-entry",
      () => {
        deps.links.updateLinkSnapshot(completedLink.id, snapshotJson);
        return prepareLinkEvent({
          spec: reservation.result.spec,
          link: completedLink,
          actor,
          occurredAt: now(),
        });
      },
    );
    deps.events.publishAfterCommit(prepared);
  }

  async function persistLink(
    spec: Spec,
    link: SpecLinkRow,
    actor: ActorProvenance,
  ): Promise<void> {
    const prepared = await deps.specs.transaction("links.insert", () => {
      const existing = deps.links
        .findByLinkedObject(link.object_kind, link.object_ref_json)
        .find(
          (candidate) =>
            candidate.category === link.category &&
            candidate.spec_id === link.spec_id &&
            candidate.element_ids_json === link.element_ids_json,
        );
      if (existing !== undefined) return null;
      deps.links.insertLink(link);
      return prepareLinkEvent({
        spec,
        link,
        actor,
        occurredAt: link.created_at,
      });
    });
    if (prepared !== null) deps.events.publishAfterCommit(prepared);
  }

  async function promoteConversation(
    rawInput: PromoteConversationInput,
  ): Promise<AuthoringSpecResult> {
    const input = promoteConversationInputSchema.parse(rawInput);
    const objectRefJson = conversationObjectRef(input.conversation);
    return runEntryPath(`conversation:${objectRefJson}`, () =>
      promoteConversationEntry(input, objectRefJson),
    );
  }

  async function promoteConversationEntry(
    input: PromoteConversationInput,
    objectRefJson: string,
  ): Promise<AuthoringSpecResult> {
    const source = await deps.loadConversationSource(input.conversation);
    const messagesById = new Map(
      source.messages.map((message) => [message.id, message]),
    );
    const selectedMessages = input.messageIds.map((messageId) => {
      const message = messagesById.get(messageId);
      if (message === undefined) {
        throw new LinksServiceError(
          "invalid_source",
          `conversation source message ${messageId} is unavailable`,
        );
      }
      return message;
    });
    const reservation = await reserveEntry({
      projectPath: input.projectPath,
      slug: input.slug,
      name: input.name,
      gatePolicy: input.gatePolicy,
      actor: input.actor,
      objectKind: "conversation",
      objectRefJson,
      category: "source",
    });
    if (reservation.link.snapshot_json !== null) return reservation.result;
    const created = reservation.result;

    const attachmentSnapshots = await Promise.all(
      source.attachments.map(async (attachment) => {
        const captured = await deps.contentStore.capture({
          ticketId: created.spec.id,
          attachmentId: newId("source-attachment"),
          fileName: attachment.fileName,
          bytes: attachment.bytes,
        });
        return {
          id: attachment.id,
          version: attachment.version,
          fileName: attachment.fileName,
          snapshotKey: captured.snapshotKey,
          sizeBytes: captured.sizeBytes,
          sha256: captured.sha256,
        };
      }),
    );
    const messageSnapshots = selectedMessages.map((message) => ({
      id: message.id,
      contentHash: sha256(
        stableStringify({ role: message.role, content: message.content }),
      ),
    }));
    const capturedAt = now();
    const sourceSnapshot = await deps.contentStore.captureText({
      ticketId: created.spec.id,
      attachmentId: newId("conversation-source"),
      fileName: "conversation-source.json",
      text: stableStringify({
        conversation: input.conversation,
        messages: selectedMessages,
        attachments: attachmentSnapshots,
        capturedAt,
      }),
    });
    await completeEntry(
      reservation,
      stableStringify({
        messages: messageSnapshots,
        attachments: attachmentSnapshots,
        sourceSnapshotKey: sourceSnapshot.snapshotKey,
        sourceSnapshotSha256: sourceSnapshot.sha256,
        capturedAt,
      }),
      input.actor,
    );
    logger.info("specs.links.conversation_promoted", {
      specId: created.spec.id,
      linkId: reservation.link.id,
      messageCount: messageSnapshots.length,
      attachmentCount: attachmentSnapshots.length,
    });
    return created;
  }

  async function graduateTicket(
    rawInput: GraduateTicketInput,
  ): Promise<AuthoringSpecResult> {
    const input = graduateTicketInputSchema.parse(rawInput);
    const entryKey = stableStringify(input.ticket);
    return runEntryPath(`ticket:${entryKey}`, () => graduateTicketEntry(input));
  }

  async function graduateTicketEntry(
    input: GraduateTicketInput,
  ): Promise<AuthoringSpecResult> {
    const ticket = requireTicket(await deps.tickets.get(input.ticket));
    const objectRefJson = ticketObjectRef(ticket);
    const resolvedAttachments = await Promise.all(
      ticket.attachments.map(async (attachment) => ({
        attachment,
        source: await deps.resolveTicketAttachment(ticket, attachment),
      })),
    );
    const reservation = await reserveEntry({
      projectPath: ticket.projectPath,
      slug: input.slug,
      name: input.name,
      gatePolicy: input.gatePolicy,
      actor: input.actor,
      objectKind: "ticket",
      objectRefJson,
      category: "graduated_from",
    });
    if (reservation.link.snapshot_json !== null) return reservation.result;
    const created = reservation.result;
    const existingSnapshot = await deps.specs.getRevisionSnapshot(
      created.draft.id,
    );
    const intentElementId = `${reservation.link.id}-intent`;
    if (
      existingSnapshot?.elements.some(
        ({ element }) => element.id === intentElementId,
      ) !== true
    ) {
      await deps.authoring.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        elementId: intentElementId,
        kind: "section",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "section",
          role: "intent_problem",
          title: "Problem",
          body: ticket.description,
        },
        baseElementVersion: null,
        actor: input.actor,
      });
    }

    const attachmentSnapshots = await Promise.all(
      resolvedAttachments.map(async ({ attachment, source }) => {
        const captured = await deps.contentStore.captureText({
          ticketId: created.spec.id,
          attachmentId: newId("ticket-source-attachment"),
          fileName: `${attachment.id}.md`,
          text: source.content,
        });
        return {
          id: attachment.id,
          description: attachment.description,
          version: source.version,
          contentHash: source.contentHash,
          snapshotKey: captured.snapshotKey,
          snapshotSha256: captured.sha256,
        };
      }),
    );
    if (resolvedAttachments.length > 0) {
      const contextBody = resolvedAttachments
        .map(
          ({ attachment, source }) =>
            `## ${attachment.description}\n\n${source.content}`,
        )
        .join("\n\n");
      const contextElementId = `${reservation.link.id}-context`;
      const currentSnapshot = await deps.specs.getRevisionSnapshot(
        created.draft.id,
      );
      if (
        currentSnapshot?.elements.some(
          ({ element }) => element.id === contextElementId,
        ) !== true
      ) {
        await deps.authoring.upsertDraftElement({
          specId: created.spec.id,
          revisionId: created.draft.id,
          elementId: contextElementId,
          kind: "section",
          parentElementId: null,
          position: 1,
          payload: {
            kind: "section",
            role: "context",
            title: "Source context",
            body: contextBody,
          },
          baseElementVersion: null,
          actor: input.actor,
        });
      }
    }

    const createdAt = now();
    await completeEntry(
      reservation,
      stableStringify({
        ticketId: ticket.id,
        title: ticket.title,
        descriptionHash: sha256(ticket.description),
        attachments: attachmentSnapshots,
        capturedAt: createdAt,
      }),
      input.actor,
    );
    logger.info("specs.links.ticket_graduated", {
      specId: created.spec.id,
      linkId: reservation.link.id,
      ticketId: ticket.id,
      attachmentCount: attachmentSnapshots.length,
    });
    return created;
  }

  async function linkTicket(rawInput: LinkTicketInput): Promise<SpecLinkRow> {
    const input = linkTicketInputSchema.parse(rawInput);
    const [spec, revisions, ticket] = await Promise.all([
      deps.specs.findById(input.specId),
      deps.specs.listRevisions(input.specId),
      deps.tickets.get(input.ticket).then(requireTicket),
    ]);
    const revision = latestRevision(revisions);
    if (spec === null || revision === null) {
      throw new LinksServiceError(
        "not_found",
        `spec ${input.specId} is unavailable`,
      );
    }
    const snapshot = await deps.specs.getRevisionSnapshot(revision.id);
    if (snapshot === null) {
      throw new LinksServiceError(
        "not_found",
        `revision ${revision.id} is unavailable`,
      );
    }
    const elementIds = [...new Set(input.elementIds ?? [])];
    for (const elementId of elementIds) {
      const element = snapshot.elements.find(
        ({ element: candidate }) => candidate.id === elementId,
      )?.element;
      if (
        element === undefined ||
        (element.kind !== "requirement" && element.kind !== "task")
      ) {
        throw new LinksServiceError(
          "invalid_source",
          `ticket links can scope only to current requirement or task elements: ${elementId}`,
        );
      }
    }
    const objectRefJson = ticketObjectRef(ticket);
    const elementIdsJson =
      elementIds.length === 0 ? null : stableStringify(elementIds);
    const existing = deps.links
      .findByLinkedObject("ticket", objectRefJson)
      .find(
        (link) =>
          link.spec_id === spec.id &&
          link.category === "reference" &&
          link.element_ids_json === elementIdsJson,
      );
    if (existing !== undefined) return existing;

    const link: SpecLinkRow = {
      id: newId("spec-link"),
      spec_id: spec.id,
      object_kind: "ticket",
      object_ref_json: objectRefJson,
      direction: "inbound",
      category: "reference",
      snapshot_json: null,
      element_ids_json: elementIdsJson,
      actor_json: stableStringify(input.actor),
      created_at: now(),
    };
    await persistLink(spec, link, input.actor);
    logger.info("specs.links.ticket_linked", {
      specId: spec.id,
      ticketId: ticket.id,
      linkId: link.id,
      scopedElementCount: elementIds.length,
    });
    return link;
  }

  async function materializeApprovedTasks(
    rawInput: MaterializeApprovedTasksInput,
  ): Promise<TicketDetail[]> {
    const input = materializeApprovedTasksInputSchema.parse(rawInput);
    const [spec, approved] = await Promise.all([
      deps.specs.findById(input.specId),
      deps.specs.findLatestApproved(input.specId),
    ]);
    if (spec === null || approved === null) {
      throw new LinksServiceError(
        "not_found",
        `approved spec ${input.specId} is unavailable`,
      );
    }
    const snapshot = await deps.specs.getRevisionSnapshot(approved.id);
    if (snapshot === null) {
      throw new LinksServiceError(
        "not_found",
        `approved revision ${approved.id} is unavailable`,
      );
    }

    const existingLinks = deps.links
      .findBySpecId(spec.id)
      .filter((link) => link.category === "materialized_from");
    const tickets: TicketDetail[] = [];
    for (const { element, version } of snapshot.elements) {
      if (version.payload.kind !== "task") continue;
      const existingLink = existingLinks.find((link) =>
        parseElementIds(link).includes(element.id),
      );
      if (existingLink !== undefined) {
        tickets.push(
          requireTicket(
            await deps.tickets.get(
              parseTicketObjectRef(existingLink.object_ref_json),
            ),
          ),
        );
        continue;
      }

      const ticket = requireTicket(
        await deps.tickets.create({
          projectName: input.projectName,
          title: version.payload.title,
          description: version.payload.instructions,
          workType: "feature",
          status: "not_started",
        }),
      );
      const createdAt = now();
      const link: SpecLinkRow = {
        id: newId("spec-link"),
        spec_id: spec.id,
        object_kind: "ticket",
        object_ref_json: ticketObjectRef(ticket),
        direction: "outbound",
        category: "materialized_from",
        snapshot_json: stableStringify({
          approvedRevisionId: approved.id,
          taskElementId: element.id,
          taskPayloadHash: version.payloadHash,
        } satisfies MaterializedTaskSnapshot),
        element_ids_json: stableStringify([element.id]),
        actor_json: stableStringify(input.actor),
        created_at: createdAt,
      };
      await persistLink(spec, link, input.actor);
      tickets.push(ticket);
    }
    logger.info("specs.links.tasks_materialized", {
      specId: spec.id,
      approvedRevisionId: approved.id,
      ticketCount: tickets.length,
    });
    return tickets;
  }

  async function getSpecReadThrough(
    spec: Spec,
    links: SpecLinkRow[],
  ): Promise<LinkedSpecReadThrough> {
    const revisions = await deps.specs.listRevisions(spec.id);
    const currentRevision = latestRevision(revisions);
    const approved = await deps.specs.findLatestApproved(spec.id);
    const [currentSnapshot, approvedSnapshot] = await Promise.all([
      currentRevision === null
        ? Promise.resolve(null)
        : deps.specs.getRevisionSnapshot(currentRevision.id),
      approved === null
        ? Promise.resolve(null)
        : deps.specs.getRevisionSnapshot(approved.id),
    ]);
    const criterionSnapshot = approvedSnapshot ?? currentSnapshot;
    const criteria =
      criterionSnapshot?.elements.filter(
        ({ version }) => version.payload.kind === "criterion",
      ) ?? [];
    const executions = deps.delivery.findExecutionsBySpecId(spec.id);
    const linkedBindings = new Map(
      executions.flatMap((execution) => {
        const linkedBinding = deps.executionBindings.findBySpecExecutionId(
          execution.id,
        );
        return linkedBinding === null
          ? []
          : [[execution.id, linkedBinding] as const];
      }),
    );
    const hasCurrentV2Attempt = executions.some(
      (execution) =>
        execution.revision_id === approved?.id &&
        linkedBindings.has(execution.id),
    );
    const legacyVerdicts =
      approved === null || hasCurrentV2Attempt
        ? []
        : deps.delivery
            .findProofVerdictsByRevision(approved.id)
            .filter((verdict) => verdict.stale_at === null);
    const waivers =
      approved === null
        ? []
        : deps.delivery
            .findWaiversByRevision(approved.id)
            .filter((waiver) => waiver.stale === 0);
    const waivedCriterionIds = new Set(
      waivers.map((waiver) => waiver.criterion_element_id),
    );
    const provenCriterionIds = new Set(
      hasCurrentV2Attempt
        ? []
        : legacyVerdicts.map((verdict) => verdict.criterion_element_id),
    );
    const mergedCriterionIds = new Set<string>();
    for (const criterion of criteria) {
      const criterionId = criterion.element.id;
      if (
        !hasCurrentV2Attempt &&
        legacyVerdicts.some(
          (verdict) =>
            verdict.criterion_element_id === criterionId &&
            verdict.execution_id !== null &&
            executions.some(
              (execution) =>
                execution.id === verdict.execution_id &&
                execution.state === "delivered",
            ),
        )
      ) {
        mergedCriterionIds.add(criterionId);
        continue;
      }
      for (const execution of executions) {
        const disposition = deps.delivery.findCriterionDisposition(
          execution.id,
          criterionId,
        );
        const linkedBinding = linkedBindings.get(execution.id) ?? null;
        const deliveredInScope =
          linkedBinding === null
            ? !hasCurrentV2Attempt &&
              execution.state === "delivered" &&
              disposition?.disposition === "in_scope" &&
              provenCriterionIds.has(criterionId)
            : execution.state === "delivered" &&
              execution.revision_id === approved?.id &&
              disposition?.disposition === "in_scope" &&
              findDeliveryVerdictForExecution(
                deps.delivery.findDeliveryVerdictsBySpecExecutionId(
                  execution.id,
                ),
                execution,
                linkedBinding,
                criterionId,
              ) !== null;
        const deliveredElsewhere =
          disposition?.disposition === "delivered_elsewhere" &&
          isEarlierMergedDelivery(deps.delivery, execution, disposition);
        if (deliveredInScope || deliveredElsewhere) {
          if (deliveredInScope) provenCriterionIds.add(criterionId);
          mergedCriterionIds.add(criterionId);
          break;
        }
      }
    }
    const knownTaskIds = new Set(
      [currentSnapshot, approvedSnapshot].flatMap(
        (snapshot) =>
          snapshot?.elements
            .filter(({ element }) => element.kind === "task")
            .map(({ element }) => element.id) ?? [],
      ),
    );
    const linkedTaskIds = new Set<string>();
    const materializedLinksByTaskId = new Map<string, SpecLinkRow>();
    for (const link of links) {
      if (link.category === "materialized_from") {
        for (const taskElementId of parseElementIds(link)) {
          linkedTaskIds.add(taskElementId);
          materializedLinksByTaskId.set(taskElementId, link);
        }
        continue;
      }
      if (link.category !== "reference") continue;
      for (const elementId of parseElementIds(link)) {
        if (knownTaskIds.has(elementId)) linkedTaskIds.add(elementId);
      }
    }
    const taskNumberById = new Map<string, number | null>();
    for (const snapshot of [currentSnapshot, approvedSnapshot]) {
      for (const { element } of snapshot?.elements ?? []) {
        if (element.kind === "task" && !taskNumberById.has(element.id)) {
          taskNumberById.set(element.id, element.number);
        }
      }
    }
    for (const taskElementId of linkedTaskIds) {
      if (taskNumberById.has(taskElementId)) continue;
      // Element rows are immutable, so a task dropped from every loaded
      // snapshot still resolves to its stable counter number.
      const element = await deps.specs.findElement(taskElementId);
      taskNumberById.set(
        taskElementId,
        element?.kind === "task" ? element.number : null,
      );
    }
    const taskHandleFor = (taskElementId: string): string | null => {
      const number = taskNumberById.get(taskElementId) ?? null;
      return number === null
        ? null
        : formatElementHandle(
            { slug: parseSpecSlug(spec.slug), kind: "task", number },
            "bare",
          );
    };
    const linkedTasks = [...linkedTaskIds].map(
      (taskElementId): LinkedTaskReadThrough => {
        const materializedLink = materializedLinksByTaskId.get(taskElementId);
        const baseline =
          materializedLink === undefined
            ? null
            : parseMaterializedSnapshot(materializedLink);
        const current =
          currentSnapshot === null
            ? null
            : taskPayload(currentSnapshot, taskElementId);
        // Claims are context-grain, so a task's progress is the progress of
        // the contexts accountable for the criteria it covers. Both the claims
        // and the criterion coverage are read from the typed execution link
        // and the pinned revision, never from graph metadata.
        const coveredCriterionIds = new Set(
          current?.coveredCriterionElementIds ?? [],
        );
        const executionEvents = executions.flatMap((execution) => {
          if (
            execution.workflow_execution_id === null ||
            execution.session_name === null
          ) {
            return [];
          }
          const linked = deps.executionBindings.findBySpecExecutionId(
            execution.id,
          );
          if (linked === null || coveredCriterionIds.size === 0) return [];
          const contextIds = new Set(
            linked.binding.claims
              .filter((claim) =>
                claim.criterionElementIds.some((criterionElementId) =>
                  coveredCriterionIds.has(criterionElementId),
                ),
              )
              .map((claim) => claim.contextId),
          );
          if (contextIds.size === 0) return [];
          return deps.workflowEvents
            .findByExecution(
              spec.projectPath,
              execution.session_name,
              execution.workflow_execution_id,
            )
            .flatMap(({ event }) =>
              event.type === "graph-workflow-task-status" &&
              contextIds.has(event.contextId)
                ? [{ status: event.status }]
                : [],
            );
        });
        const work = projectTaskWorkStatus({ executionEvents });
        let sourceTaskState: SourceTaskState = "current";
        if (current === null) {
          sourceTaskState = "removed";
        } else if (
          baseline !== null &&
          computeSpecElementPayloadHash(current) !== baseline.taskPayloadHash
        ) {
          sourceTaskState = "changed";
        }
        return {
          taskElementId,
          taskHandle: taskHandleFor(taskElementId),
          sourceTaskState,
          workStatus: work.status,
        };
      },
    );
    const deliveryCriteria = criteria.map(({ element }) => ({
      state: mergedCriterionIds.has(element.id)
        ? ("proven_and_merged" as const)
        : waivedCriterionIds.has(element.id)
          ? ("waived" as const)
          : ("pending" as const),
    }));
    return {
      specId: spec.id,
      slug: spec.slug,
      name: spec.name,
      revision: currentRevision?.number ?? 1,
      phase: projectSpecPhase({
        abandoned: spec.abandonedAt !== null,
        revisions: revisions.map((revision) => ({
          state: revision.state,
          authoringStage: revision.authoringStage,
        })),
        executionStates: executions.map((execution) => execution.state),
        deliveryCriteria,
        deliveryPending: executions.some(
          (execution) =>
            execution.state === "definition_review" ||
            execution.state === "running",
        ),
      }),
      criteriaProgress: {
        proven: criteria.filter(({ element }) =>
          provenCriterionIds.has(element.id),
        ).length,
        total: criteria.length,
      },
      linkedTasks,
    };
  }

  async function getTicketReadThrough(
    rawInput: TicketReadThroughInput,
  ): Promise<TicketReadThrough> {
    const input = ticketReadThroughInputSchema.parse(rawInput);
    const ticket = requireTicket(await deps.tickets.get(input));
    const linked = deps.links.findByLinkedObject(
      "ticket",
      ticketObjectRef(ticket),
    );
    const linksBySpec = new Map<string, SpecLinkRow[]>();
    for (const link of linked) {
      const specLinks = linksBySpec.get(link.spec_id) ?? [];
      specLinks.push(link);
      linksBySpec.set(link.spec_id, specLinks);
    }
    const projected: LinkedSpecReadThrough[] = [];
    for (const [specId, specLinks] of linksBySpec) {
      const spec = await deps.specs.findById(specId);
      if (spec === null) continue;
      projected.push(await getSpecReadThrough(spec, specLinks));
    }
    logger.debug("specs.links.ticket_read_through", {
      ticketId: ticket.id,
      linkedSpecCount: projected.length,
    });
    return { ticket, specs: projected };
  }

  async function getSpecLinkedTickets(
    rawInput: SpecLinkedTicketsInput,
  ): Promise<LinkedTicketReadThrough[]> {
    const input = specLinkedTicketsInputSchema.parse(rawInput);
    const spec = await deps.specs.findById(input.specId);
    if (spec === null) {
      throw new LinksServiceError(
        "not_found",
        `spec ${input.specId} is unavailable`,
      );
    }
    const linkedTickets: LinkedTicketReadThrough[] = [];
    const seen = new Set<string>();
    for (const link of deps.links.findBySpecId(spec.id)) {
      if (link.object_kind !== "ticket") continue;
      const identity = parseTicketObjectRef(link.object_ref_json);
      const key = `${identity.projectName}\u0000${identity.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ticket = await deps.tickets.get(identity);
      if (!ticket.ok) {
        if (ticket.error.code === "ticket_not_found") {
          logger.warn("specs.links.linked_ticket_unavailable", {
            specId: spec.id,
            projectName: identity.projectName,
            ticketNumber: identity.number,
          });
          continue;
        }
        throw new LinksServiceError(
          "ticket_operation_failed",
          `ticket operation failed: ${ticket.error.code}`,
        );
      }
      linkedTickets.push({
        projectName: ticket.value.projectName,
        number: ticket.value.number,
        title: ticket.value.title,
      });
    }
    logger.debug("specs.links.spec_linked_tickets", {
      specId: spec.id,
      linkedTicketCount: linkedTickets.length,
    });
    return linkedTickets;
  }

  return {
    promoteConversation,
    graduateTicket,
    linkTicket,
    materializeApprovedTasks,
    getTicketReadThrough,
    getSpecLinkedTickets,
  };
}
