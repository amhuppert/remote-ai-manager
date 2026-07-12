import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { BOUNDED_DESCRIPTION_BUDGET } from "./attachment-index";
import {
  createLiveTicketContextProvider,
  type LiveTicketContextProvider,
} from "./live-context";
import type { Ticket, TicketAttachment } from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const SESSION_NAME = "csm/ticket-work";

let db: Db;
let repo: TicketsRepo;
let provider: LiveTicketContextProvider;
let seq = 0;

function insertSession(sessionName: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at, finished)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    `/wt/${sessionName}`,
    `csm/${sessionName}`,
    createdAt,
    createdAt,
  );
}

async function createTicket(
  overrides: Partial<Omit<Ticket, "number">> = {},
): Promise<Ticket> {
  seq += 1;
  return repo.create({
    id: `t-${seq}`,
    projectPath: PROJECT_PATH,
    title: `Ticket ${seq}`,
    description: "",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

async function linkSession(ticket: Ticket, sessionName = SESSION_NAME) {
  seq += 1;
  insertSession(sessionName, "2026-07-04T00:00:00.000Z");
  return repo.linkStartedSession({
    id: `l-${seq}`,
    projectPath: ticket.projectPath,
    number: ticket.number,
    sessionName,
    sessionCreatedAt: "2026-07-04T00:00:00.000Z",
    startMode: "agent",
    linkedAt: "2026-07-05T00:00:00.000Z",
  });
}

async function addNoteAttachment(
  ticket: Ticket,
  description: string,
  markdown = "SECRET-NOTE-BODY",
): Promise<TicketAttachment> {
  seq += 1;
  return repo.addAttachment({
    id: `att-${seq}`,
    ticketId: ticket.id,
    description,
    payload: { kind: "note", markdown },
    createdAt: "2026-07-05T01:00:00.000Z",
    updatedAt: "2026-07-05T01:00:00.000Z",
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createTicketsRepo(db, createWriteQueue());
  provider = createLiveTicketContextProvider({
    findLinkedTicket(projectPath, sessionName) {
      return repo.findLinkedTicket(projectPath, sessionName);
    },
  });
  logSpies.info.mockClear();
  logSpies.debug.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

afterEach(() => {
  db.close();
});

describe("getForSession", () => {
  it("returns null for a session with no linked ticket", async () => {
    const block = await provider.getForSession(PROJECT_PATH, "csm/unlinked");
    expect(block).toBeNull();
  });

  it("renders identifier, title, status, complete index, and retrieval commands", async () => {
    const ticket = await createTicket({ title: "Add durable ticket context" });
    await linkSession(ticket);
    const file = await repo.addAttachment({
      id: "att-file",
      ticketId: ticket.id,
      description: "API contract",
      payload: {
        kind: "file",
        fileName: "contract.md",
        snapshotKey: "snap-1",
        mediaType: "text/markdown",
        sizeBytes: 10,
        sha256: "abc",
      },
      createdAt: "2026-07-05T01:00:00.000Z",
      updatedAt: "2026-07-05T01:00:00.000Z",
    });
    const related = await repo.addAttachment({
      id: "att-rel",
      ticketId: ticket.id,
      description: "Blocking ticket",
      payload: {
        kind: "related_ticket",
        ticketId: "other-ticket",
        identifierSnapshot: "command-center#7",
      },
      createdAt: "2026-07-05T01:00:00.000Z",
      updatedAt: "2026-07-05T01:00:00.000Z",
    });

    const identifier = `command-center#${ticket.number}`;
    const block = await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    expect(block).not.toBeNull();
    expect(block).toContain("<active-ticket>");
    expect(block).toContain("</active-ticket>");
    expect(block).toContain(`identifier: ${identifier}`);
    expect(block).toContain("title: Add durable ticket context");
    expect(block).toContain("status: In Progress");
    expect(block).toContain(
      `- ${file.id} file — API contract — cctl ticket attachment get '${identifier}' '${file.id}'`,
    );
    expect(block).toContain(
      `- ${related.id} related_ticket — Blocking ticket — cctl ticket attachment get '${identifier}' '${related.id}'; cctl ticket get 'command-center#7'`,
    );
    expect(block).toContain(`refresh: cctl ticket get '${identifier}'`);
  });

  it("renders an explicit empty index for a linked ticket with no attachments", async () => {
    const ticket = await createTicket();
    await linkSession(ticket);

    const block = await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    expect(block).toContain("attachments: none");
  });

  it("bounds long descriptions with an explicit ellipsis and never omits entries", async () => {
    const ticket = await createTicket();
    await linkSession(ticket);
    const longDescription = "x".repeat(BOUNDED_DESCRIPTION_BUDGET * 3);
    await addNoteAttachment(ticket, longDescription);
    const others = await Promise.all([
      addNoteAttachment(ticket, "short one"),
      addNoteAttachment(ticket, "short two"),
    ]);

    const block = await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    expect(block).toContain(`${"x".repeat(BOUNDED_DESCRIPTION_BUDGET - 1)}…`);
    expect(block).not.toContain("x".repeat(BOUNDED_DESCRIPTION_BUDGET));
    for (const attachment of others) {
      expect(block).toContain(attachment.id);
    }
  });

  it("never inlines attachment bodies", async () => {
    const ticket = await createTicket();
    await linkSession(ticket);
    await addNoteAttachment(ticket, "design note", "SECRET-NOTE-BODY");

    const block = await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    expect(block).toContain("design note");
    expect(block).not.toContain("SECRET-NOTE-BODY");
  });

  it("reflects attachment mutations on the next render without any refresh step", async () => {
    const ticket = await createTicket();
    await linkSession(ticket);
    const first = await provider.getForSession(PROJECT_PATH, SESSION_NAME);
    expect(first).toContain("attachments: none");

    const added = await addNoteAttachment(ticket, "added mid-session");
    const second = await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    expect(second).toContain(added.id);
    expect(second).toContain("added mid-session");

    await repo.deleteAttachment({
      ticketId: ticket.id,
      attachmentId: added.id,
      updatedAt: "2026-07-10T00:00:03.000Z",
    });
    const third = await provider.getForSession(PROJECT_PATH, SESSION_NAME);
    expect(third).toContain("attachments: none");
  });

  it("logs identifier, entry count, rendered size, and duration — never content", async () => {
    const ticket = await createTicket({ title: "Do not log me" });
    await linkSession(ticket);
    await addNoteAttachment(ticket, "secret description", "SECRET-NOTE-BODY");

    await provider.getForSession(PROJECT_PATH, SESSION_NAME);

    const calls = [...logSpies.debug.mock.calls, ...logSpies.info.mock.calls];
    const rendered = calls.find(
      ([event]) => event === "tickets.live-context.rendered",
    );
    expect(rendered).toBeDefined();
    const fields = rendered?.[1] as Record<string, unknown>;
    expect(fields.identifier).toBe(`command-center#${ticket.number}`);
    expect(fields.entryCount).toBe(1);
    expect(typeof fields.renderedChars).toBe("number");
    expect(typeof fields.durationMs).toBe("number");

    const allLogged = JSON.stringify(calls);
    expect(allLogged).not.toContain("secret description");
    expect(allLogged).not.toContain("SECRET-NOTE-BODY");
    expect(allLogged).not.toContain("Do not log me");
  });
});
