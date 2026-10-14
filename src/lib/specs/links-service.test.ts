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
let authoring: AuthoringService;
let service: LinksService;
let secondService: LinksService;
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
  const eventsRepo = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
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
    attention: eventsRepo,
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
    authoring,
    events,
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

/**
 * Tasks exist only in legacy plan revisions, which no authoring path can write,
 * so the task is seeded through the repository below the guarded boundary.
 */
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
  await authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: "criterion-1",
    kind: "criterion",
    parentElementId: "requirement-1",
    payload: {
      kind: "criterion",
      text: "A ticket is created.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: AGENT,
  });
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
  ).run(created.draft.id);
  await specs.createDraftElement({
    id: "task-1",
    specId: created.spec.id,
    revisionId: created.draft.id,
    kind: "task",
    parentElementId: null,
    payload: {
      kind: "task",
      title: "Build materialized work",
      instructions: "Implement the approved task.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-1"],
      dependsOnTaskElementIds: [],
    },
    createdAt: "2026-07-18T17:00:30.000Z",
    updatedAt: "2026-07-18T17:00:30.000Z",
  });
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-07-18T17:00:31.000Z",
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

  it("graduates a ticket into the draft under review instead of forking past it", async () => {
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
    // A requirement with a criterion is the least a review can be asked for.
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      payload: {
        kind: "criterion",
        text: "A graduated ticket lands in the open draft.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    const requested = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    expect(requested).toMatchObject({
      ok: true,
      revision: { id: created.draft.id, state: "draft" },
    });
    const revisionsBefore = db
      .prepare("SELECT COUNT(*) AS count FROM spec_revisions")
      .get() as { count: number };

    const graduated = await service.graduateTicket({
      ticket: { projectName: PROJECT_NAME, number: 1 },
      slug: "graduated-ticket",
      name: "Graduated ticket",
      gatePolicy: { preset: "contract-bearing" },
      actor: AGENT,
    });

    expect(graduated.spec.id).toBe(created.spec.id);
    expect(graduated.draft.id).toBe(created.draft.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_revisions").get(),
    ).toEqual(revisionsBefore);
    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.revision.state).toBe("draft");
    expect(snapshot?.elements.map(({ version }) => version.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "requirement" }),
        expect.objectContaining({
          kind: "section",
          role: "intent_problem",
          body: expect.stringContaining("Ticket description becomes intent."),
        }),
      ]),
    );
    expect(linksRepo.findBySpecId(created.spec.id)).toEqual([
      expect.objectContaining({
        category: "graduated_from",
        object_kind: "ticket",
      }),
    ]);
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
});
