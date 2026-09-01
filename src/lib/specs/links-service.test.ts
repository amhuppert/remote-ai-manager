import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { TicketDetail } from "@/lib/tickets/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import {
  createSpecDeliveryRepo,
  type SpecDeliveryRepo,
} from "@/lib/state-store/spec-delivery-repo";
import {
  createSpecExecutionBindingRepo,
  type SpecExecutionBindingRepo,
} from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import {
  createSpecLinksRepo,
  type SpecLinksRepo,
} from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  SpecRevisionInReviewError,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import {
  createLinksService,
  type LinksService,
  type LinksServiceDeps,
} from "./links-service";

const PROJECT_PATH = "/repos/native-sdd-links";
const PROJECT_NAME = "native-sdd-links";
const AGENT = { kind: "agent", conversationId: "conversation-author" } as const;

let db: Db;
let specs: SpecsRepo;
let linksRepo: SpecLinksRepo;
let delivery: SpecDeliveryRepo;
let executionBindings: SpecExecutionBindingRepo;
let authoring: AuthoringService;
let service: LinksService;
let secondService: LinksService;
let workflowEventsByExecution: Map<string, GraphWorkflowExecutionEvent[]>;
let sourceText: string;
let sourceAttachmentText: string;
let captured: Map<string, Uint8Array>;
let tickets: Map<number, TicketDetail>;
let createTicketCalls: number;
let updateTicketCalls: number;
let captureFailures: number;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  const review = createSpecReviewRepo(db);
  linksRepo = createSpecLinksRepo(db);
  delivery = createSpecDeliveryRepo(db);
  executionBindings = createSpecExecutionBindingRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: createSpecEventsRepo(db).appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  idSequence = 0;
  timeSequence = 0;
  const newId = (prefix: string) => {
    idSequence += 1;
    return `${prefix}-${idSequence}`;
  };
  const now = () => {
    timeSequence += 1;
    return `2026-07-18T17:00:${String(timeSequence).padStart(2, "0")}.000Z`;
  };
  authoring = createAuthoringService({
    specs,
    review,
    links: linksRepo,
    events,
    newId,
    now,
  });

  sourceText = "Original conversation intent.";
  sourceAttachmentText = "Original attachment bytes.";
  captured = new Map();
  tickets = new Map();
  createTicketCalls = 0;
  updateTicketCalls = 0;
  captureFailures = 0;
  workflowEventsByExecution = new Map();

  const ticketOne: TicketDetail = {
    id: "ticket-1",
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    number: 1,
    title: "Graduate this ticket",
    description: "Ticket description becomes intent.",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-07-18T16:00:00.000Z",
    updatedAt: "2026-07-18T16:00:00.000Z",
    attachments: [
      {
        id: "ticket-attachment-1",
        ticketId: "ticket-1",
        description: "Architecture notes",
        payload: { kind: "note", markdown: "Attached architecture context." },
        createdAt: "2026-07-18T16:01:00.000Z",
        updatedAt: "2026-07-18T16:01:00.000Z",
      },
    ],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
  tickets.set(1, ticketOne);

  const serviceDeps: LinksServiceDeps = {
    specs,
    links: linksRepo,
    delivery,
    executionBindings,
    authoring,
    events,
    workflowEvents: {
      findByExecution(_projectPath, _sessionName, executionId) {
        return workflowEventsByExecution.get(executionId) ?? [];
      },
    },
    tickets: {
      async get(identity) {
        const ticket = tickets.get(identity.number);
        return ticket === undefined
          ? {
              ok: false,
              error: {
                code: "ticket_not_found",
                identifier: `${identity.projectName}-${identity.number}`,
              },
            }
          : { ok: true, value: ticket };
      },
      async create(input) {
        createTicketCalls += 1;
        const number = Math.max(0, ...tickets.keys()) + 1;
        const ticket: TicketDetail = {
          id: `ticket-${number}`,
          projectPath: PROJECT_PATH,
          projectName: input.projectName,
          number,
          title: input.title,
          description: input.description,
          workType: input.workType ?? "feature",
          status: input.status ?? "not_started",
          createdAt: now(),
          updatedAt: now(),
          attachments: [],
          sessions: [],
          relationships: [],
          statusUpdates: { total: 0, recent: [] },
        };
        tickets.set(number, ticket);
        return { ok: true, value: ticket };
      },
      async update() {
        updateTicketCalls += 1;
        throw new Error("LinksService must not update ticket-owned state");
      },
    },
    contentStore: {
      async capture(input) {
        if (captureFailures > 0) {
          captureFailures -= 1;
          throw new Error("simulated snapshot capture failure");
        }
        const snapshotKey = `${input.ticketId}/${input.attachmentId}/${input.fileName}`;
        captured.set(snapshotKey, input.bytes);
        return {
          snapshotKey,
          fileName: input.fileName,
          sizeBytes: input.bytes.byteLength,
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
        };
      },
      async captureText(input) {
        const bytes = Buffer.from(input.text, "utf8");
        const snapshotKey = `${input.ticketId}/${input.attachmentId}/${input.fileName}`;
        captured.set(snapshotKey, bytes);
        return {
          snapshotKey,
          fileName: input.fileName,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
    async loadConversationSource() {
      return {
        messages: [
          {
            id: "message-1",
            role: "user" as const,
            content: [{ type: "text" as const, text: sourceText }],
          },
        ],
        attachments: [
          {
            id: "attachment-1",
            version: "v1",
            fileName: "intent.txt",
            bytes: Buffer.from(sourceAttachmentText, "utf8"),
          },
        ],
      };
    },
    async resolveTicketAttachment(_ticket, attachment) {
      return {
        content:
          attachment.payload.kind === "note"
            ? attachment.payload.markdown
            : "resolved attachment",
        version: attachment.updatedAt,
        contentHash: createHash("sha256")
          .update(JSON.stringify(attachment.payload))
          .digest("hex"),
      };
    },
    newId,
    now,
  };
  service = createLinksService(serviceDeps);
  secondService = createLinksService(serviceDeps);
});

afterEach(() => db.close());

async function createApprovedTaskSpec() {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "materialize-spec",
    name: "Materialize spec",
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "Materialize approved tasks.",
        priority: "must" as const,
        risk: "high" as const,
      },
    },
    actor: AGENT,
  });
  await specs.updateGatePolicy({
    specId: created.spec.id,
    gatePolicy: { preset: "exploratory" },
    updatedAt: "2026-07-18T17:00:00.500Z",
  });
  for (const element of [
    {
      elementId: "criterion-1",
      kind: "criterion" as const,
      parentElementId: "requirement-1",
      position: 1,
      payload: {
        kind: "criterion" as const,
        text: "A ticket is created.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      elementId: "task-1",
      kind: "task" as const,
      parentElementId: null,
      position: 2,
      payload: {
        kind: "task" as const,
        title: "Build materialized work",
        instructions: "Implement the approved task.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
    },
  ]) {
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = ? WHERE id = ?",
    ).run(element.kind === "task" ? "plan" : "requirements", created.draft.id);
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      ...element,
      baseElementVersion: null,
      actor: AGENT,
    });
  }
  await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: AGENT,
  });
  return created;
}

describe("LinksService entry paths and read-through", () => {
  it("promotes a conversation with an immutable message and content-store attachment snapshot", async () => {
    const [promoted, concurrent] = await Promise.all([
      secondService.promoteConversation({
        projectPath: PROJECT_PATH,
        slug: "promoted-conversation",
        name: "Promoted conversation",
        gatePolicy: { preset: "contract-bearing" },
        conversation: {
          projectName: PROJECT_NAME,
          sessionName: "session-1",
          conversationId: "conversation-1",
        },
        messageIds: ["message-1"],
        actor: AGENT,
      }),
      service.promoteConversation({
        projectPath: PROJECT_PATH,
        slug: "ignored-concurrent-retry",
        name: "Ignored concurrent retry",
        gatePolicy: { preset: "contract-bearing" },
        conversation: {
          projectName: PROJECT_NAME,
          sessionName: "session-1",
          conversationId: "conversation-1",
        },
        messageIds: ["message-1"],
        actor: AGENT,
      }),
    ]);
    expect(concurrent.spec.id).toBe(promoted.spec.id);
    sourceText = "Edited conversation intent.";
    sourceAttachmentText = "Edited attachment bytes.";

    const link = linksRepo.findBySpecId(promoted.spec.id)[0]!;
    const snapshot = JSON.parse(link.snapshot_json!);
    expect(snapshot.messages).toEqual([
      { id: "message-1", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(snapshot.attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        version: "v1",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(
      Buffer.from(
        captured.get(snapshot.sourceSnapshotKey)! as Uint8Array,
      ).toString("utf8"),
    ).toContain("Original conversation intent.");
    expect(createTicketCalls).toBe(0);

    const repeated = await service.promoteConversation({
      projectPath: PROJECT_PATH,
      slug: "ignored-on-retry",
      name: "Ignored on retry",
      gatePolicy: { preset: "contract-bearing" },
      conversation: {
        projectName: PROJECT_NAME,
        sessionName: "session-1",
        conversationId: "conversation-1",
      },
      messageIds: ["message-1"],
      actor: AGENT,
    });
    expect(repeated.spec.id).toBe(promoted.spec.id);
    expect(linksRepo.findBySpecId(promoted.spec.id)).toHaveLength(1);
  });

  it("graduates a ticket by seeding intent from its description and attachments while leaving the ticket intact", async () => {
    const before = structuredClone(tickets.get(1)!);
    const graduated = await service.graduateTicket({
      ticket: { projectName: PROJECT_NAME, number: 1 },
      slug: "graduated-ticket",
      name: "Graduated ticket",
      gatePolicy: { preset: "contract-bearing" },
      actor: AGENT,
    });
    const snapshot = await specs.getRevisionSnapshot(graduated.draft.id);
    expect(snapshot?.elements.map(({ version }) => version.payload)).toEqual([
      expect.objectContaining({
        kind: "section",
        role: "intent_problem",
        body: expect.stringContaining("Ticket description becomes intent."),
      }),
      expect.objectContaining({
        kind: "section",
        role: "context",
        body: expect.stringContaining("Attached architecture context."),
      }),
    ]);
    expect(linksRepo.findBySpecId(graduated.spec.id)).toEqual([
      expect.objectContaining({
        category: "graduated_from",
        object_kind: "ticket",
      }),
    ]);
    expect(tickets.get(1)).toEqual(before);
    expect(updateTicketCalls).toBe(0);
  });

  it("refuses to reserve an entry on a spec whose revision is under review", async () => {
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug: "graduated-ticket",
      name: "Graduated ticket",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: {
        elementId: "requirement-1",
        kind: "requirement" as const,
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement" as const,
          statement: "Reservations respect review.",
          priority: "must" as const,
          risk: "high" as const,
        },
      },
      actor: AGENT,
    });
    await specs.proposeRevision({
      revisionId: created.draft.id,
      proposedAt: "2026-07-18T17:10:00.000Z",
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T17:11:00.000Z",
    });
    const { revision: amendment } = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    await specs.proposeRevision({
      revisionId: amendment.id,
      proposedAt: "2026-07-18T17:12:00.000Z",
    });
    const revisionsBefore = db
      .prepare("SELECT COUNT(*) AS count FROM spec_revisions")
      .get() as { count: number };

    const refusal = await service
      .graduateTicket({
        ticket: { projectName: PROJECT_NAME, number: 1 },
        slug: "graduated-ticket",
        name: "Graduated ticket",
        gatePolicy: { preset: "contract-bearing" },
        actor: AGENT,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(SpecRevisionInReviewError);
    if (!(refusal instanceof SpecRevisionInReviewError)) throw refusal;
    expect(refusal.proposals.map(({ id }) => id)).toEqual([amendment.id]);
    expect(refusal.approvedBase?.id).toBe(created.draft.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_revisions").get(),
    ).toEqual(revisionsBefore);
    expect(linksRepo.findBySpecId(created.spec.id)).toEqual([]);
    expect(updateTicketCalls).toBe(0);
  });

  it("reuses a durable entry reservation after capture fails before source completion", async () => {
    captureFailures = 1;
    const input = {
      projectPath: PROJECT_PATH,
      slug: "capture-retry",
      name: "Capture retry",
      gatePolicy: { preset: "contract-bearing" as const },
      conversation: {
        projectName: PROJECT_NAME,
        sessionName: "session-retry",
        conversationId: "conversation-retry",
      },
      messageIds: ["message-1"],
      actor: AGENT,
    };
    await expect(service.promoteConversation(input)).rejects.toThrow(
      "simulated snapshot capture failure",
    );
    const reservedSpecId = (
      db.prepare("SELECT id FROM specs").get() as { id: string }
    ).id;

    const retried = await secondService.promoteConversation({
      ...input,
      slug: "ignored-after-reservation",
    });
    expect(retried.spec.id).toBe(reservedSpecId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM specs").get()).toEqual({
      count: 1,
    });
    const links = linksRepo.findBySpecId(reservedSpecId);
    expect(links).toHaveLength(1);
    expect(links[0]?.snapshot_json).not.toBeNull();
  });

  it("materializes approved tasks as linked tickets", async () => {
    const created = await createApprovedTaskSpec();
    const materialized = await service.materializeApprovedTasks({
      specId: created.spec.id,
      projectName: PROJECT_NAME,
      actor: AGENT,
    });
    expect(materialized).toEqual([
      expect.objectContaining({
        title: "Build materialized work",
        description: "Implement the approved task.",
      }),
    ]);
    expect(createTicketCalls).toBe(1);
    expect(linksRepo.findBySpecId(created.spec.id)).toEqual([
      expect.objectContaining({
        category: "materialized_from",
        element_ids_json: JSON.stringify(["task-1"]),
      }),
    ]);
  });

  it("links an existing ticket directly to a spec with optional requirement and task scope", async () => {
    const created = await createApprovedTaskSpec();
    const linked = await service.linkTicket({
      specId: created.spec.id,
      ticket: { projectName: PROJECT_NAME, number: 1 },
      elementIds: ["requirement-1", "task-1"],
      actor: AGENT,
    });

    expect(linked).toMatchObject({
      spec_id: created.spec.id,
      object_kind: "ticket",
      category: "reference",
      element_ids_json: JSON.stringify(["requirement-1", "task-1"]),
    });
    expect(tickets.get(1)?.status).toBe("not_started");
    expect(updateTicketCalls).toBe(0);

    await expect(
      service.getTicketReadThrough({
        projectName: PROJECT_NAME,
        number: 1,
      }),
    ).resolves.toMatchObject({
      specs: [
        {
          linkedTasks: [
            {
              taskElementId: "task-1",
              taskHandle: "T1",
              sourceTaskState: "current",
              workStatus: "pending",
            },
          ],
        },
      ],
    });

    await expect(
      service.getSpecLinkedTickets({ specId: created.spec.id }),
    ).resolves.toEqual([
      {
        projectName: PROJECT_NAME,
        number: 1,
        title: "Graduate this ticket",
      },
    ]);
  });

  it("keeps proof-only phase Approved and projects workflow task events", async () => {
    const created = await createApprovedTaskSpec();
    const [ticket] = await service.materializeApprovedTasks({
      specId: created.spec.id,
      projectName: PROJECT_NAME,
      actor: AGENT,
    });
    if (ticket === undefined) throw new Error("expected a materialized ticket");
    delivery.saveProofVerdict({
      id: "verdict-1",
      spec_id: created.spec.id,
      criterion_element_id: "criterion-1",
      revision_id: created.draft.id,
      execution_id: null,
      verdict_kind: "deterministic_validator",
      evidence_ids_json: "[]",
      verdict_at: "2026-07-18T17:30:00.000Z",
      stale_at: null,
      stale_reason: null,
    });

    const proofOnly = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });
    expect(proofOnly.specs[0]).toMatchObject({
      name: "Materialize spec",
      revision: 1,
      phase: { primary: "approved" },
      criteriaProgress: { proven: 1, total: 1 },
      linkedTasks: [{ workStatus: "pending", taskHandle: "T1" }],
    });

    delivery.insertExecution({
      id: "execution-1",
      spec_id: created.spec.id,
      revision_id: created.draft.id,
      scope_json: JSON.stringify({
        taskElementIds: ["task-1"],
        criterionElementIds: ["criterion-1"],
      }),
      state: "running",
      execution_start_dial: "gate",
      workflow_definition_id: "workflow-definition-1",
      workflow_definition_revision: 1,
      workflow_execution_binding_json: null,
      workflow_execution_id: "workflow-execution-1",
      session_name: "native-sdd-execution",
      delivered_at: null,
      abandoned_reason: null,
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      created_at: "2026-07-18T17:31:00.000Z",
      updated_at: "2026-07-18T17:31:00.000Z",
    });
    // The typed link is the only place a task's accountable contexts are
    // stated: the claim names the context and the criteria T1 covers.
    executionBindings.insert({
      specExecutionId: "execution-1",
      workflowExecutionId: "workflow-execution-1",
      binding: {
        schemaVersion: 2,
        candidateId: "candidate-1",
        candidateHash: `sha256:${"c".repeat(64)}`,
        pinnedRevisionId: created.draft.id,
        dispositions: [],
        claims: [
          { contextId: "context-1", criterionElementIds: ["criterion-1"] },
        ],
      },
      createdAt: "2026-07-18T17:31:00.000Z",
    });
    workflowEventsByExecution.set("workflow-execution-1", [
      {
        occurredAt: "2026-07-18T17:32:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-task-status",
          projectName: PROJECT_NAME,
          sessionName: "native-sdd-execution",
          executionId: "workflow-execution-1",
          contextId: "context-1",
          taskId: "spec-task-task-1",
          status: "running",
          source: "user",
          order: 1,
        },
      },
    ]);

    const running = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });
    expect(running.specs[0]).toMatchObject({
      phase: { primary: "executing" },
      linkedTasks: [{ workStatus: "running" }],
    });
  });

  it("projects a v2-only delivered criterion through its bound candidate identity", async () => {
    const created = await createApprovedTaskSpec();
    const [ticket] = await service.materializeApprovedTasks({
      specId: created.spec.id,
      projectName: PROJECT_NAME,
      actor: AGENT,
    });
    if (ticket === undefined) throw new Error("expected a materialized ticket");

    delivery.insertExecution({
      id: "execution-v2-delivered",
      spec_id: created.spec.id,
      revision_id: created.draft.id,
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [],
      }),
      state: "delivered",
      execution_start_dial: "gate",
      workflow_definition_id: "workflow-definition-v2",
      workflow_definition_revision: 1,
      workflow_execution_binding_json: null,
      workflow_execution_id: "workflow-execution-v2",
      session_name: "native-sdd-execution",
      delivered_at: "2026-07-18T17:32:00.000Z",
      abandoned_reason: null,
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      created_at: "2026-07-18T17:31:00.000Z",
      updated_at: "2026-07-18T17:32:00.000Z",
    });
    delivery.saveCriterionDisposition({
      execution_id: "execution-v2-delivered",
      criterion_element_id: "criterion-1",
      disposition: "in_scope",
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: "2026-07-18T17:31:00.000Z",
      updated_at: "2026-07-18T17:31:00.000Z",
    });
    executionBindings.insert({
      specExecutionId: "execution-v2-delivered",
      workflowExecutionId: "workflow-execution-v2",
      binding: {
        schemaVersion: 2,
        candidateId: "candidate-v2",
        candidateHash: `sha256:${"a".repeat(64)}`,
        pinnedRevisionId: created.draft.id,
        dispositions: [],
        claims: [],
      },
      createdAt: "2026-07-18T17:31:00.000Z",
    });
    delivery.saveDeliveryVerdict({
      id: "delivery-verdict-v2",
      specExecutionId: "execution-v2-delivered",
      workflowExecutionId: "workflow-execution-v2",
      candidateId: "candidate-v2",
      candidateHash: `sha256:${"a".repeat(64)}`,
      criterionElementId: "criterion-1",
      satisfyingContextId: "stable-spawner",
      recordedAt: "2026-07-18T17:32:00.000Z",
    });

    const readThrough = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });

    expect(readThrough.specs[0]).toMatchObject({
      phase: { primary: "delivered" },
      criteriaProgress: { proven: 1, total: 1 },
    });

    db.prepare("DELETE FROM spec_delivery_verdicts").run();
    delivery.saveDeliveryVerdict({
      id: "delivery-verdict-wrong-candidate",
      specExecutionId: "execution-v2-delivered",
      workflowExecutionId: "workflow-execution-v2",
      candidateId: "candidate-other",
      candidateHash: `sha256:${"b".repeat(64)}`,
      criterionElementId: "criterion-1",
      satisfyingContextId: "stable-spawner",
      recordedAt: "2026-07-18T17:33:00.000Z",
    });
    const wrongCandidate = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });
    expect(wrongCandidate.specs[0]).toMatchObject({
      phase: { primary: "approved" },
      criteriaProgress: { proven: 0, total: 1 },
    });
  });

  it("computes ticket display from current spec state without storing a mirror or updating ticket fields", async () => {
    const created = await createApprovedTaskSpec();
    const [ticket] = await service.materializeApprovedTasks({
      specId: created.spec.id,
      projectName: PROJECT_NAME,
      actor: AGENT,
    });
    expect(ticket).toBeDefined();
    if (ticket === undefined) throw new Error("expected a materialized ticket");
    const before = structuredClone(ticket);
    const amendment = await specs.createDraftFromBase({
      id: "revision-legacy-plan-replacement",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "plan",
      createdAt: "2026-07-18T17:45:00.000Z",
    });
    await authoring.removeDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "task-1",
      baseElementVersion: 1,
      actor: AGENT,
    });

    expect(await authoring.lintDraft(created.spec.id, amendment.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "9.9.materialized-task-change",
          severity: "advisory",
        }),
      ]),
    );

    const display = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });
    expect(display).toMatchObject({
      ticket: before,
      specs: [
        {
          specId: created.spec.id,
          phase: { primary: "draft" },
          criteriaProgress: { proven: 0, total: 1 },
          linkedTasks: [
            {
              taskElementId: "task-1",
              taskHandle: "T1",
              sourceTaskState: "removed",
              workStatus: "pending",
            },
          ],
        },
      ],
    });
    expect(tickets.get(ticket.number)).toEqual(before);
    expect(updateTicketCalls).toBe(0);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('tickets') WHERE name LIKE 'spec_%'",
        )
        .all(),
    ).toEqual([]);
  });

  it("keeps the spec handle of a materialized task that is absent from every loaded snapshot", async () => {
    const created = await createApprovedTaskSpec();
    const [ticket] = await service.materializeApprovedTasks({
      specId: created.spec.id,
      projectName: PROJECT_NAME,
      actor: AGENT,
    });
    if (ticket === undefined) throw new Error("expected a materialized ticket");

    // A later approved revision replaces the task: the linked task element is
    // in neither the current nor the approved snapshot, only its immutable
    // element row remains.
    const amendment = await specs.createDraftFromBase({
      id: "revision-legacy-plan-handle",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "plan",
      createdAt: "2026-07-18T17:45:00.000Z",
    });
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "task-replacement",
      kind: "task",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task",
        title: "Replacement work",
        instructions: "Cover the criterion instead of task-1.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    await authoring.removeDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "task-1",
      baseElementVersion: 1,
      actor: AGENT,
    });
    const proposed = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      actor: AGENT,
    });
    expect(proposed.ok).toBe(true);

    const display = await service.getTicketReadThrough({
      projectName: PROJECT_NAME,
      number: ticket.number,
    });
    expect(display.specs[0]?.linkedTasks).toEqual([
      expect.objectContaining({
        taskElementId: "task-1",
        taskHandle: "T1",
        sourceTaskState: "removed",
      }),
    ]);
  });
});
