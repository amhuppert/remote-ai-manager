import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logging = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logging.warn,
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createTicketOperationLock,
  ticketOperationKey,
} from "./operation-lock";
import {
  ticketChangedEventSchema,
  ticketStatusSchema,
  type QuickTicketCreateWarning,
  type TicketAttachment,
  type TicketChangedEvent,
} from "./schemas";
import type {
  CreateAttachmentPlan,
  PlanCreateAttachmentsInput,
} from "./create-attachment-planner";
import { createTicketService, type TicketService } from "./service";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";

let db: Db;
let service: TicketService;
let repo: TicketsRepo;
let events: SSEEvent[];
let publishImpl: PublishFn;
let deletedContentTicketIds: string[];
let deleteTicketContentImpl: (ticketId: string) => Promise<void>;
let projectAvailable: boolean;
let gatedProjectPaths: string[];
let projectGateDepth: number;
let eventPublishedInsideProjectGate: boolean;
let enterProjectGate: (projectPath: string) => void;
let projectDeletionPrecededOperation: boolean;
let planCreateAttachments: (
  input: PlanCreateAttachmentsInput,
) => Promise<CreateAttachmentPlan>;

let idSeq: number;
let clock: number;

beforeEach(() => {
  logging.warn.mockClear();
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  events = [];
  projectGateDepth = 0;
  eventPublishedInsideProjectGate = false;
  publishImpl = (event) => {
    events.push(event);
    eventPublishedInsideProjectGate ||= projectGateDepth > 0;
    return { delivered: true };
  };
  deletedContentTicketIds = [];
  deleteTicketContentImpl = async (ticketId) => {
    deletedContentTicketIds.push(ticketId);
  };
  projectAvailable = true;
  gatedProjectPaths = [];
  enterProjectGate = () => {};
  projectDeletionPrecededOperation = false;
  planCreateAttachments = async () => ({
    attachments: [],
    pendingConversationAttachmentIds: [],
    warnings: [],
    compensate: async () => {},
    afterCommit: () => {},
  });
  idSeq = 0;
  clock = 0;
  repo = createTicketsRepo(db, createWriteQueue());
  service = createTicketService({
    repo,
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    resolveAvailableProjectPath: async (name) =>
      name === PROJECT_NAME && projectAvailable ? PROJECT_PATH : null,
    attachmentPlanner: {
      plan(input) {
        return planCreateAttachments(input);
      },
    },
    publish: (event) => publishImpl(event),
    deleteTicketContent: (ticketId) => deleteTicketContentImpl(ticketId),
    runProjectTicketOperation: async (projectPath, operation) => {
      gatedProjectPaths.push(projectPath);
      enterProjectGate(projectPath);
      projectGateDepth += 1;
      try {
        return await operation({ projectDeletionPrecededOperation });
      } finally {
        projectGateDepth -= 1;
      }
    },
    runTicketOperation: (_key, fn) => fn(),
    now: () => {
      clock += 1;
      return `2026-07-10T00:00:${String(clock).padStart(2, "0")}.000Z`;
    },
    generateId: () => {
      idSeq += 1;
      return `ticket-${idSeq}`;
    },
  });
});

afterEach(() => {
  db.close();
});

async function createTicket(
  overrides: Partial<{
    projectName: string;
    title: string;
    description: string;
    workType: "feature" | "bug" | "research" | "tech_debt" | "performance";
    status: "not_started" | "in_progress" | "done" | "blocked" | "closed";
  }> = {},
) {
  return service.create({
    projectName: PROJECT_NAME,
    title: "Ticket title",
    workType: "feature",
    ...overrides,
  });
}

function ticketChanged(event: SSEEvent): TicketChangedEvent {
  return ticketChangedEventSchema.parse(event);
}

describe("create", () => {
  it("holds the project ticket-operation gate through persistence and event publication", async () => {
    await createTicket();

    expect(gatedProjectPaths).toEqual([PROJECT_PATH]);
    expect(events).toHaveLength(1);
    expect(eventPublishedInsideProjectGate).toBe(true);
  });

  it("keeps the committed ticket and logs context when publication reports failed delivery", async () => {
    const deliveryError = new Error("transport unavailable");
    publishImpl = () => ({ delivered: false, error: deliveryError });

    const result = await createTicket();

    expect(result.ok).toBe(true);
    expect(await repo.list({ sort: "updated" })).toHaveLength(1);
    expect(logging.warn).toHaveBeenCalledWith(
      "tickets.service.event_broadcast_failed",
      {
        change: "created",
        projectName: PROJECT_NAME,
        ticketNumber: 1,
        error: "transport unavailable",
      },
    );
  });

  it("resolves the project name to its canonical path at the boundary", async () => {
    const result = await createTicket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectPath).toBe(PROJECT_PATH);
    expect(result.value.projectName).toBe(PROJECT_NAME);
    expect(result.value.number).toBe(1);
    expect(result.value.attachments).toEqual([]);
    expect(result.value.sessions).toEqual([]);
  });

  it("applies the Not Started default when status is unspecified", async () => {
    const result = await createTicket();
    expect(result.ok && result.value.status).toBe("not_started");
  });

  it("keeps an explicit status", async () => {
    const result = await createTicket({ status: "blocked" });
    expect(result.ok && result.value.status).toBe("blocked");
  });

  it("returns validation_failed for an unknown project name", async () => {
    const result = await createTicket({ projectName: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
    if (result.error.code !== "validation_failed") return;
    expect(result.error.issues.some((i) => i.path === "projectName")).toBe(
      true,
    );
    expect(events).toHaveLength(0);
  });

  it("returns validation_failed with issues for invalid input", async () => {
    const result = await createTicket({ title: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
    if (result.error.code !== "validation_failed") return;
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(events).toHaveLength(0);
  });

  it("rejects creation when a retained project is currently unavailable", async () => {
    projectAvailable = false;

    const result = await createTicket();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
    expect(events).toHaveLength(0);
  });

  it("revalidates project availability after entering the project gate", async () => {
    enterProjectGate = () => {
      projectAvailable = false;
    };

    const result = await createTicket();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
    expect(await repo.list({ sort: "updated" })).toEqual([]);
    expect(events).toEqual([]);
  });

  it("does not recreate ticket ownership after waiting behind project deletion", async () => {
    projectDeletionPrecededOperation = true;

    const result = await createTicket();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
    expect(projectAvailable).toBe(true);
    expect(await repo.list({ sort: "updated" })).toEqual([]);
    expect(events).toEqual([]);
  });

  it("persists the planner's attachments, publishes their real count, and runs post-commit work", async () => {
    const afterCommit = vi.fn<CreateAttachmentPlan["afterCommit"]>();
    const warning: QuickTicketCreateWarning = {
      code: "conversation_source_unavailable",
      message: "Conversation context was omitted.",
    };
    planCreateAttachments = async (input) => {
      const attachment: TicketAttachment = {
        id: "attachment-1",
        ticketId: input.ticketId,
        description: "Diagnostic report",
        payload: { kind: "note", markdown: "# Report" },
        createdAt: "2026-07-10T00:00:02.000Z",
        updatedAt: "2026-07-10T00:00:02.000Z",
      };
      return {
        attachments: [attachment],
        pendingConversationAttachmentIds: [],
        warnings: [warning],
        compensate: async () => {},
        afterCommit,
      };
    };

    const result = await service.create({
      projectName: PROJECT_NAME,
      title: "Bug report",
      workType: "bug",
      diagnostics: {
        capturedAt: "2026-07-19T12:00:00.000Z",
        route: { url: "/projects", viewState: "list" },
        identities: { deepLinks: [] },
        clientErrors: [],
        removed: [],
      },
      autoStartRequested: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attachments).toHaveLength(1);
    expect(result.warnings).toEqual([warning]);
    expect(afterCommit).toHaveBeenCalledWith(result.value);
    const event = ticketChanged(events.at(-1)!);
    expect(event.listItem?.attachmentCount).toBe(1);
    expect(event.attachmentIndexChanged).toBe(true);
  });

  it("keeps a committed create successful and runs post-commit work when event preparation fails", async () => {
    const afterCommit = vi.fn<CreateAttachmentPlan["afterCommit"]>();
    planCreateAttachments = async () => ({
      attachments: [],
      pendingConversationAttachmentIds: [],
      warnings: [],
      compensate: async () => {},
      afterCommit,
    });
    vi.spyOn(repo, "findListItem").mockRejectedValueOnce(
      new Error("read unavailable"),
    );

    const result = await createTicket();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(afterCommit).toHaveBeenCalledWith(result.value);
    expect(events).toHaveLength(0);
    const persisted = await service.get({
      projectName: PROJECT_NAME,
      number: result.value.number,
    });
    expect(persisted.ok).toBe(true);
  });

  it("compensates planned blobs when the guaranteed precommit create rejects", async () => {
    const compensate = vi.fn<CreateAttachmentPlan["compensate"]>();
    const afterCommit = vi.fn<CreateAttachmentPlan["afterCommit"]>();
    planCreateAttachments = async () => ({
      attachments: [
        {
          id: "attachment-1",
          ticketId: "wrong-ticket",
          description: "Screenshot",
          payload: { kind: "note", markdown: "report" },
          createdAt: "2026-07-10T00:00:02.000Z",
          updatedAt: "2026-07-10T00:00:02.000Z",
        },
      ],
      pendingConversationAttachmentIds: [],
      warnings: [],
      compensate,
      afterCommit,
    });

    await expect(createTicket()).rejects.toThrow();

    expect(compensate).toHaveBeenCalledTimes(1);
    expect(afterCommit).not.toHaveBeenCalled();
    expect(await repo.list({ sort: "updated" })).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("get", () => {
  it("returns the detail for an existing ticket", async () => {
    await createTicket();
    const result = await service.get({ projectName: PROJECT_NAME, number: 1 });
    expect(result.ok && result.value.number).toBe(1);
  });

  it("returns ticket_not_found naming the identifier for an unknown ticket", async () => {
    const result = await service.get({ projectName: PROJECT_NAME, number: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "ticket_not_found",
      identifier: "command-center#99",
    });
  });

  it("treats an unknown project as an unknown ticket", async () => {
    const result = await service.get({ projectName: "nope", number: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "ticket_not_found",
      identifier: "nope#1",
    });
  });

  it("keeps retained tickets operable while their project is unavailable", async () => {
    await createTicket();
    projectAvailable = false;

    const getResult = await service.get({
      projectName: PROJECT_NAME,
      number: 1,
    });
    const listResult = await service.list({ projectName: PROJECT_NAME });
    const updateResult = await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      status: "blocked",
    });
    const deleteResult = await service.delete({
      projectName: PROJECT_NAME,
      number: 1,
    });

    expect(getResult.ok).toBe(true);
    expect(listResult.ok && listResult.value).toHaveLength(1);
    expect(updateResult.ok && updateResult.value.status).toBe("blocked");
    expect(deleteResult.ok).toBe(true);
  });
});

describe("list", () => {
  it("lists tickets filtered by resolved project name", async () => {
    await createTicket({ title: "A" });
    await createTicket({ title: "B", workType: "bug" });
    const result = await service.list({ projectName: PROJECT_NAME });
    expect(result.ok && result.value).toHaveLength(2);

    const filtered = await service.list({
      projectName: PROJECT_NAME,
      workType: "bug",
    });
    expect(filtered.ok && filtered.value.map((t) => t.title)).toEqual(["B"]);
  });

  it("returns validation_failed for an unknown project filter", async () => {
    const result = await service.list({ projectName: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_failed");
  });
});

describe("update", () => {
  it("permits every explicit status transition", async () => {
    await createTicket();
    const statuses = ticketStatusSchema.options;
    for (const from of statuses) {
      for (const to of statuses) {
        const setup = await service.update({
          projectName: PROJECT_NAME,
          number: 1,
          status: from,
        });
        expect(setup.ok).toBe(true);
        const result = await service.update({
          projectName: PROJECT_NAME,
          number: 1,
          status: to,
        });
        expect(result.ok && result.value.status).toBe(to);
      }
    }
  });

  it("updates fields and bumps updatedAt", async () => {
    const created = await createTicket();
    if (!created.ok) throw new Error("create failed");
    const result = await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      title: "Renamed",
      workType: "performance",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Renamed");
    expect(result.value.workType).toBe("performance");
    expect(result.value.updatedAt > created.value.updatedAt).toBe(true);
  });

  it("returns ticket_not_found for an unknown ticket", async () => {
    const result = await service.update({
      projectName: PROJECT_NAME,
      number: 42,
      status: "done",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "ticket_not_found",
      identifier: "command-center#42",
    });
  });

  it("keeps a committed update successful when event preparation fails", async () => {
    await createTicket();
    events.length = 0;
    vi.spyOn(repo, "findListItem").mockRejectedValueOnce(
      new Error("read unavailable"),
    );

    const result = await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      status: "done",
    });

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
    const persisted = await service.get({
      projectName: PROJECT_NAME,
      number: 1,
    });
    expect(persisted.ok && persisted.value.status).toBe("done");
  });
});

describe("delete", () => {
  it("returns the removed identity", async () => {
    await createTicket();
    const result = await service.delete({
      projectName: PROJECT_NAME,
      number: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      id: "ticket-1",
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      number: 1,
    });
    const gone = await service.get({ projectName: PROJECT_NAME, number: 1 });
    expect(gone.ok).toBe(false);
  });

  it("returns ticket_not_found when the ticket does not exist", async () => {
    const result = await service.delete({
      projectName: PROJECT_NAME,
      number: 7,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "ticket_not_found",
      identifier: "command-center#7",
    });
    expect(deletedContentTicketIds).toEqual([]);
  });

  it("removes captured ticket content only after the database aggregate is gone", async () => {
    await createTicket();
    let rowExistedDuringCleanup = true;
    deleteTicketContentImpl = async (ticketId) => {
      rowExistedDuringCleanup =
        db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(ticketId) !==
        undefined;
      deletedContentTicketIds.push(ticketId);
    };

    const result = await service.delete({
      projectName: PROJECT_NAME,
      number: 1,
    });

    expect(result.ok).toBe(true);
    expect(deletedContentTicketIds).toEqual(["ticket-1"]);
    expect(rowExistedDuringCleanup).toBe(false);
  });

  it("keeps a committed deletion successful when content cleanup fails", async () => {
    await createTicket();
    deleteTicketContentImpl = async () => {
      throw new Error("disk unavailable");
    };

    const result = await service.delete({
      projectName: PROJECT_NAME,
      number: 1,
    });

    expect(result.ok).toBe(true);
    const gone = await service.get({ projectName: PROJECT_NAME, number: 1 });
    expect(gone.ok).toBe(false);
  });

  it("queues behind an in-flight start on the same ticket", async () => {
    await createTicket();
    const lock = createTicketOperationLock();
    service = createTicketService({
      repo: createTicketsRepo(db, createWriteQueue()),
      attachmentPlanner: {
        plan(input) {
          return planCreateAttachments(input);
        },
      },
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      resolveAvailableProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      publish: (event) => publishImpl(event),
      deleteTicketContent: (ticketId) => deleteTicketContentImpl(ticketId),
      runProjectTicketOperation: (_projectPath, operation) =>
        operation({ projectDeletionPrecededOperation: false }),
      runTicketOperation: (key, fn) => lock.runExclusive(key, fn),
      now: () => "2026-07-10T00:00:00.000Z",
      generateId: () => "id",
    });
    const hold = lock.tryAcquireStart(ticketOperationKey(PROJECT_PATH, 1));
    expect(hold).not.toBeNull();

    let settled = false;
    const deletion = service
      .delete({ projectName: PROJECT_NAME, number: 1 })
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    hold?.release();
    const result = await deletion;
    expect(result.ok).toBe(true);
  });
});

describe("change events", () => {
  it("publishes exactly one schema-valid created event carrying the lean list item", async () => {
    await createTicket();
    expect(events).toHaveLength(1);
    const event = ticketChanged(events[0] as SSEEvent);
    expect(event.type).toBe("ticket-changed");
    expect(event.change).toBe("created");
    expect(event.projectName).toBe(PROJECT_NAME);
    expect(event.ticketNumber).toBe(1);
    expect(event.attachmentIndexChanged).toBe(false);
    expect(event.linkedSessionName).toBeUndefined();
    expect(event.listItem).toMatchObject({
      id: "ticket-1",
      projectName: PROJECT_NAME,
      number: 1,
      status: "not_started",
      attachmentCount: 0,
      activeSessionName: null,
    });
  });

  it("publishes exactly one updated event with the current list item", async () => {
    await createTicket();
    events.length = 0;
    await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      status: "done",
    });
    expect(events).toHaveLength(1);
    const event = ticketChanged(events[0] as SSEEvent);
    expect(event.change).toBe("updated");
    expect(event.listItem?.status).toBe("done");
  });

  it("emits strictly ordered revisions when the mutation clock is equal or regresses", async () => {
    await createTicket();
    events.length = 0;

    clock = 0;
    await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      title: "Equal clock",
    });
    clock = -1;
    await service.update({
      projectName: PROJECT_NAME,
      number: 1,
      title: "Regressed clock",
    });

    const [first, second] = events.map(ticketChanged);
    const firstRevision = first?.listItem?.updatedAt ?? "";
    const secondRevision = second?.listItem?.updatedAt ?? "";
    expect(firstRevision).toBe("2026-07-10T00:00:01.001Z");
    expect(secondRevision).toBe("2026-07-10T00:00:01.002Z");
    expect(secondRevision > firstRevision).toBe(true);
  });

  it("publishes exactly one deleted event with a null list item", async () => {
    await createTicket();
    events.length = 0;
    await service.delete({ projectName: PROJECT_NAME, number: 1 });
    expect(events).toHaveLength(1);
    const event = ticketChanged(events[0] as SSEEvent);
    expect(event.change).toBe("deleted");
    expect(event.listItem).toBeNull();
  });

  it("publishes the deleted ticket before authoritative relationship events for surviving neighbors", async () => {
    const target = await createTicket({ title: "Delete me" });
    const survivor = await createTicket({ title: "Survivor" });
    if (!target.ok || !survivor.ok) throw new Error("ticket setup failed");
    await repo.addRelationship({
      id: "relationship-before-delete",
      anchorTicketId: target.value.id,
      relationType: "depends_on",
      sourceTicketId: target.value.id,
      targetTicketId: survivor.value.id,
      description: "Survivor is a prerequisite",
      createdAt: "2026-07-10T00:00:02.500Z",
    });
    events.length = 0;

    await service.delete({ projectName: PROJECT_NAME, number: 1 });

    expect(events.map(ticketChanged)).toMatchObject([
      {
        change: "deleted",
        projectName: PROJECT_NAME,
        ticketNumber: 1,
        listItem: null,
      },
      {
        change: "relationships",
        projectName: PROJECT_NAME,
        ticketNumber: 2,
        listItem: {
          id: survivor.value.id,
          number: 2,
          updatedAt: "2026-07-10T00:00:03.000Z",
        },
      },
    ]);
    expect((await repo.find(PROJECT_PATH, 2))?.relationships).toEqual([]);
  });

  it("publishes no event for failed mutations", async () => {
    await service.update({
      projectName: PROJECT_NAME,
      number: 9,
      status: "done",
    });
    await service.delete({ projectName: PROJECT_NAME, number: 9 });
    await createTicket({ title: "" });
    expect(events).toHaveLength(0);
  });

  it("publishes no event for reads", async () => {
    await createTicket();
    events.length = 0;
    await service.get({ projectName: PROJECT_NAME, number: 1 });
    await service.list({});
    expect(events).toHaveLength(0);
  });

  it("never rolls back a committed mutation when publication throws", async () => {
    publishImpl = () => {
      throw new Error("sse transport down");
    };
    const result = await createTicket();
    expect(result.ok).toBe(true);
    const persisted = await service.get({
      projectName: PROJECT_NAME,
      number: 1,
    });
    expect(persisted.ok).toBe(true);
  });
});
