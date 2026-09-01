import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SSEEvent } from "@/lib/api/sse-events";
import type { TicketStatusUpdateListInput } from "@/lib/state-store/tickets-repo";
import { encodeTicketKeysetCursor } from "./ticket-keyset-cursor";
import {
  createTicketStatusUpdateService,
  type TicketStatusUpdateService,
  type TicketStatusUpdateServiceDeps,
  type TicketStatusUpdateServiceRepo,
} from "./status-update-service";
import {
  ticketChangedEventSchema,
  type TicketDetail,
  type TicketListItem,
  type TicketStatus,
  type TicketStatusUpdate,
  type TicketStatusUpdateAuthor,
} from "./schemas";

const PROJECT_NAME = "alpha";
const PROJECT_PATH = "/repos/alpha";

const USER_AUTHOR = { kind: "user" } as const;
const AGENT_AUTHOR: TicketStatusUpdateAuthor = {
  kind: "agent",
  conversationId: "conversation-1",
  conversationName: "Implement tickets",
  projectName: PROJECT_NAME,
  scope: "session",
  sessionName: "enhanced-tickets",
  backend: "codex",
  redactedProfileSnapshot: null,
};

function ticket(
  id = "ticket-1",
  status: TicketStatus = "not_started",
  updatedAt = "2026-08-31T11:00:00.000Z",
): TicketDetail {
  return {
    id,
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    number: 1,
    title: "Ticket one",
    description: "",
    workType: "feature",
    status,
    createdAt: "2026-08-31T11:00:00.000Z",
    updatedAt,
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
}

function listItem(detail: TicketDetail): TicketListItem {
  return {
    id: detail.id,
    projectPath: detail.projectPath,
    projectName: detail.projectName,
    number: detail.number,
    title: detail.title,
    workType: detail.workType,
    status: detail.status,
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

interface HarnessOverrides extends Omit<
  Partial<TicketStatusUpdateServiceDeps>,
  "repo"
> {
  repo?: Partial<TicketStatusUpdateServiceRepo>;
}

interface Harness {
  service: TicketStatusUpdateService;
  events: SSEEvent[];
  gatedPaths: string[];
  lockedKeys: string[];
  added: TicketStatusUpdate[];
  listed: TicketStatusUpdateListInput[];
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const { repo: repoOverrides, ...dependencyOverrides } = overrides;
  const currentTicket = ticket();
  const events: SSEEvent[] = [];
  const gatedPaths: string[] = [];
  const lockedKeys: string[] = [];
  const added: TicketStatusUpdate[] = [];
  const listed: TicketStatusUpdateListInput[] = [];
  const persistedUpdate: TicketStatusUpdate = {
    id: "update-new",
    ticketId: currentTicket.id,
    bodyMarkdown: "Shipped the slice.",
    author: USER_AUTHOR,
    createdAt: "2026-08-31T11:01:00.000Z",
  };
  const repo: TicketStatusUpdateServiceRepo = {
    find: async (projectPath, number) =>
      projectPath === PROJECT_PATH && number === 1 ? currentTicket : null,
    findListItem: async (projectPath, number) =>
      projectPath === PROJECT_PATH && number === 1
        ? listItem(currentTicket)
        : null,
    listStatusUpdates: async (input) => {
      listed.push(input);
      return { items: [persistedUpdate], total: 1, nextCursor: null };
    },
    findStatusUpdate: async (_ticketId, updateId) =>
      updateId === persistedUpdate.id ? persistedUpdate : null,
    addStatusUpdate: async (update) => {
      added.push(update);
      return { update, ticket: currentTicket };
    },
    ...repoOverrides,
  };
  const service = createTicketStatusUpdateService({
    repo,
    resolveProjectPath: async (projectName) =>
      projectName === PROJECT_NAME ? PROJECT_PATH : null,
    runProjectTicketOperation: async (projectPath, operation) => {
      gatedPaths.push(projectPath);
      return operation({ projectDeletionPrecededOperation: false });
    },
    runTicketOperation: async (key, operation) => {
      lockedKeys.push(key);
      return operation();
    },
    publish: (event) => {
      events.push(event);
      return { delivered: true };
    },
    now: () => "2026-08-31T11:01:00.000Z",
    generateId: () => "update-new",
    ...dependencyOverrides,
  });
  return { service, events, gatedPaths, lockedKeys, added, listed };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TicketStatusUpdateService", () => {
  it("validates body and resolved author provenance before side effects", async () => {
    const addStatusUpdate = vi.fn();
    const runProjectTicketOperation = vi.fn();
    const harness = makeHarness({
      repo: { addStatusUpdate },
      runProjectTicketOperation,
    });

    const emptyBody = await harness.service.post({
      projectName: PROJECT_NAME,
      number: 1,
      bodyMarkdown: " \n\t ",
      author: USER_AUTHOR,
    });
    const invalidAuthor = await harness.service.post({
      projectName: PROJECT_NAME,
      number: 1,
      bodyMarkdown: "Progress",
      author: { kind: "user", conversationId: "forbidden" } as never,
    });

    expect(emptyBody).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(invalidAuthor).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(runProjectTicketOperation).not.toHaveBeenCalled();
    expect(addStatusUpdate).not.toHaveBeenCalled();
  });

  it("normalizes page size and validates the opaque cursor before reads", async () => {
    const harness = makeHarness();
    const cursor = encodeTicketKeysetCursor({
      timestamp: "2026-08-31T11:01:00.000Z",
      id: "update-new",
    });

    const firstPage = await harness.service.list({
      projectName: PROJECT_NAME,
      number: 1,
    });
    const nextPage = await harness.service.list({
      projectName: PROJECT_NAME,
      number: 1,
      limit: 100,
      cursor,
    });
    const badLimit = await harness.service.list({
      projectName: PROJECT_NAME,
      number: 1,
      limit: 101,
    });
    const badCursor = await harness.service.list({
      projectName: PROJECT_NAME,
      number: 1,
      cursor: "invalid-cursor",
    });

    expect(firstPage.ok).toBe(true);
    expect(nextPage.ok).toBe(true);
    expect(harness.listed).toEqual([
      { ticketId: "ticket-1", limit: 20 },
      { ticketId: "ticket-1", limit: 100, cursor },
    ]);
    expect(badLimit).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(badCursor).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  });

  it("accepts resolved agent provenance, re-reads after the gate, and publishes the committed revision", async () => {
    let insideGate = false;
    const before = ticket("ticket-before");
    const committed = ticket(
      "ticket-after",
      "closed",
      "2026-08-31T11:02:00.000Z",
    );
    const persisted: TicketStatusUpdate = {
      id: "update-new",
      ticketId: committed.id,
      bodyMarkdown: "The closed ticket still accepts a deliberate update.",
      author: AGENT_AUTHOR,
      createdAt: "2026-08-31T11:02:00.000Z",
    };
    const addStatusUpdate = vi.fn(async () => ({
      update: persisted,
      ticket: committed,
    }));
    const harness = makeHarness({
      repo: {
        find: async () => (insideGate ? committed : before),
        findListItem: async () => listItem(committed),
        addStatusUpdate,
      },
      runProjectTicketOperation: async (_path, operation) => {
        insideGate = true;
        return operation({ projectDeletionPrecededOperation: true });
      },
    });

    const result = await harness.service.post({
      projectName: PROJECT_NAME,
      number: 1,
      bodyMarkdown: persisted.bodyMarkdown,
      author: AGENT_AUTHOR,
    });

    expect(addStatusUpdate).toHaveBeenCalledWith({
      id: "update-new",
      ticketId: "ticket-after",
      bodyMarkdown: persisted.bodyMarkdown,
      author: AGENT_AUTHOR,
      createdAt: "2026-08-31T11:01:00.000Z",
    });
    expect(result).toEqual({
      ok: true,
      value: { update: persisted, ticket: committed },
    });
    expect(harness.lockedKeys).toEqual([`${PROJECT_PATH}::1`]);
    expect(
      harness.events.map((event) => ticketChangedEventSchema.parse(event)),
    ).toEqual([
      {
        type: "ticket-changed",
        change: "status_updates",
        projectName: PROJECT_NAME,
        ticketNumber: 1,
        listItem: listItem(committed),
        attachmentIndexChanged: false,
      },
    ]);
  });

  it.each<TicketStatus>([
    "not_started",
    "in_progress",
    "done",
    "blocked",
    "closed",
  ])("posts while the ticket status is %s", async (status) => {
    const current = ticket("ticket-1", status);
    const addStatusUpdate = vi.fn(async (update: TicketStatusUpdate) => ({
      update,
      ticket: current,
    }));
    const harness = makeHarness({
      repo: {
        find: async () => current,
        findListItem: async () => listItem(current),
        addStatusUpdate,
      },
    });

    const result = await harness.service.post({
      projectName: PROJECT_NAME,
      number: 1,
      bodyMarkdown: "Progress",
      author: USER_AUTHOR,
    });

    expect(result.ok).toBe(true);
    expect(addStatusUpdate).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a missing host ticket from a missing append-only update", async () => {
    const missingUpdate = makeHarness({
      repo: { findStatusUpdate: async () => null },
    });
    const missingTicket = makeHarness({
      repo: { find: async () => null },
    });

    const updateResult = await missingUpdate.service.get({
      projectName: PROJECT_NAME,
      number: 1,
      updateId: "missing",
    });
    const ticketResult = await missingTicket.service.get({
      projectName: PROJECT_NAME,
      number: 1,
      updateId: "missing",
    });

    expect(updateResult).toEqual({ ok: true, value: null });
    expect(ticketResult).toEqual({
      ok: false,
      error: { code: "ticket_not_found", identifier: `${PROJECT_NAME}#1` },
    });
  });

  it("exposes no update or delete operation for append-only entries", () => {
    const harness = makeHarness();
    expect(Object.keys(harness.service).sort()).toEqual([
      "get",
      "list",
      "post",
    ]);
  });
});
