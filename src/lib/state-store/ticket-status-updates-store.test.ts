import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
}));

import { PersistenceError } from "@/lib/shared/errors";
import {
  ticketStatusUpdateSchema,
  type TicketStatusUpdate,
} from "@/lib/tickets/schemas";
import { decodeTicketKeysetCursor } from "@/lib/tickets/ticket-keyset-cursor";
import { _createTestDb, _createTestDbAtPath } from "./state-db";
import {
  createTicketStatusUpdatesStore,
  type TicketStatusUpdatesStore,
} from "./ticket-status-updates-store";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/alpha";
const BASE_TIME = "2026-08-31T12:00:00.000Z";

let db: Db;
let store: TicketStatusUpdatesStore;
let updateSequence = 0;

function seedTicket(target: Db): void {
  target
    .prepare("INSERT INTO projects (root_path) VALUES (?)")
    .run(PROJECT_PATH);
  target
    .prepare(
      `INSERT INTO tickets
         (id, project_path, ticket_number, title, description, work_type,
          status, created_at, updated_at)
       VALUES ('ticket-1', ?, 1, 'Ticket', '', 'feature', 'not_started', ?, ?)`,
    )
    .run(PROJECT_PATH, BASE_TIME, BASE_TIME);
}

function timestamp(offset: number): string {
  return new Date(Date.parse(BASE_TIME) + offset).toISOString();
}

function update(
  overrides: Partial<TicketStatusUpdate> = {},
): TicketStatusUpdate {
  updateSequence += 1;
  return ticketStatusUpdateSchema.parse({
    id: `update-${String(updateSequence).padStart(3, "0")}`,
    ticketId: "ticket-1",
    bodyMarkdown: `Update **${updateSequence}**`,
    author: { kind: "user" },
    createdAt: timestamp(updateSequence),
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedTicket(db);
  store = createTicketStatusUpdatesStore(db);
  updateSequence = 0;
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

afterEach(() => {
  db.close();
});

describe("append-only status updates", () => {
  it("persists and reloads a user-authored Markdown update", () => {
    const input = update();

    expect(store.append(input)).toEqual(input);
    expect(store.getForTicket(input.ticketId, input.id)).toEqual(input);
    expect(store.getForTicket("another-ticket", input.id)).toBeNull();
  });

  it("round-trips an immutable redacted agent provenance snapshot", () => {
    const input = update({
      author: {
        kind: "agent",
        conversationId: "conversation-1",
        conversationName: "Implement ticket stores",
        projectName: "alpha",
        scope: "session",
        sessionName: "csm/ticket-stores",
        backend: "codex",
        redactedProfileSnapshot: {
          tier: "project",
          id: "ticket-implementer",
          name: "Ticket Implementer",
          revision: 2,
          sourceContentHash: `sha256:${"a".repeat(64)}`,
          resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
        },
      },
    });

    store.append(input);

    expect(store.getForTicket(input.ticketId, input.id)).toEqual(input);
  });

  it("accepts the exact 256 KiB UTF-8 boundary and rejects one character beyond it", () => {
    const atBoundary = "é".repeat(131_072);
    const persisted = update({ bodyMarkdown: atBoundary });
    expect(store.append(persisted).bodyMarkdown).toHaveLength(131_072);

    expect(() =>
      store.append({
        ...persisted,
        id: "oversized",
        bodyMarkdown: `${atBoundary}é`,
      }),
    ).toThrow();
    expect(store.getForTicket("ticket-1", "oversized")).toBeNull();
  });

  it("rejects empty or whitespace-only bodies through the public schema", () => {
    expect(() =>
      store.append({ ...update(), id: "empty", bodyMarkdown: " \n\t " }),
    ).toThrow();
  });

  it("fails closed on valid JSON that violates the strict public author schema", () => {
    db.prepare(
      `INSERT INTO ticket_status_updates
         (id, ticket_id, body_markdown, author_json, created_at)
       VALUES ('corrupt-author', 'ticket-1', 'Body', ?, ?)`,
    ).run(JSON.stringify({ kind: "user", leaked: true }), timestamp(1));

    expect(() => store.getForTicket("ticket-1", "corrupt-author")).toThrow(
      PersistenceError,
    );
  });

  it("logs safe issue metadata when malformed author JSON contains secret fragments", () => {
    const malformedAuthor =
      '{"kind":"agent","token":DO-NOT-LOG-TOKEN,"profile":"DO-NOT-LOG-PROFILE"}';
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      `INSERT INTO ticket_status_updates
         (id, ticket_id, body_markdown, author_json, created_at)
       VALUES ('malformed-author', 'ticket-1', 'Body', ?, ?)`,
    ).run(malformedAuthor, timestamp(1));
    db.pragma("ignore_check_constraints = OFF");

    expect(() => store.getForTicket("ticket-1", "malformed-author")).toThrow(
      PersistenceError,
    );

    expect(logSpies.error).toHaveBeenCalledWith(
      "state-store.ticket-status-updates.schema_validation_failure",
      {
        entity: "ticket_status_update_author",
        identifier: "malformed-author",
        issues: { kind: "invalid_json" },
      },
    );
    const logged = JSON.stringify(logSpies.error.mock.calls);
    expect(logged).not.toContain("DO-NOT-LOG-TOKEN");
    expect(logged).not.toContain("DO-NOT-LOG-PROFILE");
  });
});

describe("newest-first keyset reads", () => {
  it("walks same-timestamp rows without gaps or duplicates", () => {
    const sameTimestamp = timestamp(100);
    for (let index = 1; index <= 7; index += 1) {
      store.append(
        update({
          id: `page-${index}`,
          createdAt: sameTimestamp,
        }),
      );
    }

    const seen: string[] = [];
    let cursor;
    do {
      const page = store.listForTicket("ticket-1", { limit: 3, cursor });
      expect(page.total).toBe(7);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor
        ? (decodeTicketKeysetCursor(page.nextCursor) ?? undefined)
        : undefined;
      if (page.nextCursor !== null) expect(cursor).toBeDefined();
    } while (cursor !== undefined);

    expect(seen).toEqual([
      "page-7",
      "page-6",
      "page-5",
      "page-4",
      "page-3",
      "page-2",
      "page-1",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("returns a five-most-recent summary with the full total", () => {
    for (let index = 1; index <= 7; index += 1) store.append(update());

    const summary = store.getSummary("ticket-1");
    expect(summary.total).toBe(7);
    expect(summary.recent.map((item) => item.id)).toEqual([
      "update-007",
      "update-006",
      "update-005",
      "update-004",
      "update-003",
    ]);
  });

  it("returns empty pages and summaries for tickets without updates", () => {
    expect(store.listForTicket("missing", { limit: 20 })).toEqual({
      items: [],
      total: 0,
      nextCursor: null,
    });
    expect(store.getSummary("missing")).toEqual({ total: 0, recent: [] });
  });
});

describe("cascade and durability", () => {
  it("cascades updates when their ticket is permanently deleted", () => {
    store.append(update());
    db.prepare("DELETE FROM tickets WHERE id = 'ticket-1'").run();

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM ticket_status_updates").get(),
    ).toEqual({ n: 0 });
  });

  it("retains bodies, provenance, and deterministic order after reopening SQLite", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-ticket-updates-"));
    const dbPath = path.join(tempDir, "state.db");
    let writer: Db | undefined;
    let reader: Db | undefined;
    try {
      writer = _createTestDbAtPath(dbPath);
      seedTicket(writer);
      const writerStore = createTicketStatusUpdatesStore(writer);
      const first = update({ id: "durable-user" });
      const second = update({
        id: "durable-agent",
        author: {
          kind: "agent",
          conversationId: "conversation-durable",
          conversationName: null,
          projectName: "alpha",
          scope: "project",
          backend: "claude",
          redactedProfileSnapshot: null,
        },
      });
      writerStore.append(first);
      writerStore.append(second);
      writer.close();
      writer = undefined;

      reader = _createTestDbAtPath(dbPath);
      const readerStore = createTicketStatusUpdatesStore(reader);
      expect(readerStore.listForTicket("ticket-1", { limit: 20 })).toEqual({
        items: [second, first],
        total: 2,
        nextCursor: null,
      });
      expect(readerStore.getForTicket("ticket-1", second.id)).toEqual(second);
    } finally {
      reader?.close();
      writer?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
