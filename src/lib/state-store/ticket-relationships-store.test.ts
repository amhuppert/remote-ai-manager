import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { decodeTicketKeysetCursor } from "@/lib/tickets/ticket-keyset-cursor";
import { PersistenceError } from "@/lib/shared/errors";
import { _createTestDb, _createTestDbAtPath } from "./state-db";
import {
  createTicketRelationshipsStore,
  type AddTicketRelationshipInput,
  type TicketRelationshipsStore,
} from "./ticket-relationships-store";

type Db = InstanceType<typeof Database>;

const ALPHA = "/repos/alpha";
const BETA = "/repos/beta";
const BASE_TIME = "2026-08-31T12:00:00.000Z";

let db: Db;
let store: TicketRelationshipsStore;
let relationshipSequence = 0;

function insertProject(target: Db, projectPath: string): void {
  target
    .prepare("INSERT INTO projects (root_path) VALUES (?)")
    .run(projectPath);
}

function insertTicket(
  target: Db,
  id: string,
  projectPath: string,
  number: number,
  title = `Ticket ${id}`,
): void {
  target
    .prepare(
      `INSERT INTO tickets
         (id, project_path, ticket_number, title, description, work_type,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'feature', 'not_started', ?, ?)`,
    )
    .run(id, projectPath, number, title, BASE_TIME, BASE_TIME);
}

function seedTickets(target: Db): void {
  insertProject(target, ALPHA);
  insertProject(target, BETA);
  for (let index = 1; index <= 9; index += 1) {
    insertTicket(target, `a-${index}`, ALPHA, index);
  }
  for (let index = 1; index <= 3; index += 1) {
    insertTicket(target, `b-${index}`, BETA, index);
  }
}

function timestamp(offset: number): string {
  return new Date(Date.parse(BASE_TIME) + offset).toISOString();
}

function relationship(
  overrides: Partial<AddTicketRelationshipInput> = {},
): AddTicketRelationshipInput {
  relationshipSequence += 1;
  const at = timestamp(relationshipSequence);
  return {
    id: `rel-${String(relationshipSequence).padStart(3, "0")}`,
    relationType: "depends_on",
    sourceTicketId: "a-1",
    targetTicketId: "a-2",
    description: `Rationale ${relationshipSequence}`,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function add(
  targetStore: TicketRelationshipsStore,
  input: AddTicketRelationshipInput,
) {
  return db.transaction(() => targetStore.add(input)).immediate();
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedTickets(db);
  store = createTicketRelationshipsStore(db);
  relationshipSequence = 0;
});

afterEach(() => {
  db.close();
});

describe("canonical relationship directions and relative views", () => {
  it("projects every stored direction relative to either endpoint", () => {
    const related = relationship({
      relationType: "related",
      sourceTicketId: "a-1",
      targetTicketId: "a-2",
    });
    const dependency = relationship({
      sourceTicketId: "a-1",
      targetTicketId: "b-1",
    });
    const hierarchy = relationship({
      relationType: "parent_child",
      sourceTicketId: "a-1",
      targetTicketId: "a-3",
    });
    add(store, related);
    add(store, dependency);
    add(store, hierarchy);

    expect(store.getForTicket("a-1", related.id)).toMatchObject({
      role: "related",
      otherTicket: { id: "a-2", projectName: "alpha", number: 2 },
    });
    expect(store.getForTicket("a-2", related.id)).toMatchObject({
      role: "related",
      otherTicket: { id: "a-1" },
    });
    expect(store.getForTicket("a-1", dependency.id)).toMatchObject({
      role: "depends_on",
      otherTicket: { id: "b-1", projectName: "beta" },
    });
    expect(store.getForTicket("b-1", dependency.id)).toMatchObject({
      role: "blocks",
      otherTicket: { id: "a-1" },
    });
    expect(store.getForTicket("a-1", hierarchy.id)).toMatchObject({
      role: "child",
      otherTicket: { id: "a-3" },
    });
    expect(store.getForTicket("a-3", hierarchy.id)).toMatchObject({
      role: "parent",
      otherTicket: { id: "a-1" },
    });
    expect(store.getForTicket("a-4", hierarchy.id)).toBeNull();
  });

  it("orders aggregate views by parent, children, depends on, blocks, related", () => {
    const rows = [
      relationship({
        id: "related",
        relationType: "related",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      }),
      relationship({
        id: "blocks",
        sourceTicketId: "a-3",
        targetTicketId: "a-1",
      }),
      relationship({
        id: "depends-old",
        sourceTicketId: "a-1",
        targetTicketId: "a-4",
        updatedAt: timestamp(20),
      }),
      relationship({
        id: "depends-new",
        sourceTicketId: "a-1",
        targetTicketId: "a-5",
        updatedAt: timestamp(21),
      }),
      relationship({
        id: "child",
        relationType: "parent_child",
        sourceTicketId: "a-1",
        targetTicketId: "a-6",
      }),
      relationship({
        id: "parent",
        relationType: "parent_child",
        sourceTicketId: "a-7",
        targetTicketId: "a-1",
      }),
    ];
    for (const row of rows) add(store, row);

    expect(store.listAllForTicket("a-1").map((view) => view.id)).toEqual([
      "parent",
      "child",
      "depends-new",
      "depends-old",
      "blocks",
      "related",
    ]);
  });
});

describe("relationship graph invariants", () => {
  it("rejects self-links before SQLite exposes a raw constraint error", () => {
    expect(() =>
      add(
        store,
        relationship({ sourceTicketId: "a-1", targetTicketId: "a-1" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ kind: "self_link" }),
      }),
    );
  });

  it("enforces symmetric related uniqueness with the existing id", () => {
    const first = relationship({
      id: "rel-existing",
      relationType: "related",
      sourceTicketId: "a-1",
      targetTicketId: "a-2",
    });
    add(store, first);

    expect(() =>
      add(
        store,
        relationship({
          id: "rel-duplicate",
          relationType: "related",
          sourceTicketId: "a-1",
          targetTicketId: "a-2",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          kind: "duplicate",
          relationshipId: "rel-existing",
        },
      }),
    );
  });

  it("reparents a child atomically and returns the removed parent edge", () => {
    const oldParent = relationship({
      id: "old-parent",
      relationType: "parent_child",
      sourceTicketId: "a-1",
      targetTicketId: "a-3",
    });
    add(store, oldParent);

    const next = relationship({
      id: "new-parent",
      relationType: "parent_child",
      sourceTicketId: "a-2",
      targetTicketId: "a-3",
    });
    const result = add(store, next);

    expect(result.relationship.id).toBe("new-parent");
    expect(result.replacedParent).toEqual(oldParent);
    expect(store.getForTicket("a-3", "old-parent")).toBeNull();
    expect(store.getForTicket("a-3", "new-parent")).toMatchObject({
      role: "parent",
      otherTicket: { id: "a-2" },
    });
  });

  it("treats adding the same parent edge as a duplicate, not a reparent", () => {
    add(
      store,
      relationship({
        id: "parent-existing",
        relationType: "parent_child",
        sourceTicketId: "a-1",
        targetTicketId: "a-3",
      }),
    );

    expect(() =>
      add(
        store,
        relationship({
          id: "parent-duplicate",
          relationType: "parent_child",
          sourceTicketId: "a-1",
          targetTicketId: "a-3",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: {
          kind: "duplicate",
          relationshipId: "parent-existing",
        },
      }),
    );
  });

  it("maps a relationship id collision to the typed duplicate conflict", () => {
    add(
      store,
      relationship({
        id: "colliding-id",
        relationType: "related",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      }),
    );

    expect(() =>
      add(
        store,
        relationship({
          id: "colliding-id",
          sourceTicketId: "a-2",
          targetTicketId: "a-3",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: { kind: "duplicate", relationshipId: "colliding-id" },
      }),
    );
  });

  it("rejects dependency cycles in either traversal direction", () => {
    add(store, relationship({ sourceTicketId: "a-1", targetTicketId: "a-2" }));
    add(store, relationship({ sourceTicketId: "a-2", targetTicketId: "a-3" }));

    expect(() =>
      add(
        store,
        relationship({ sourceTicketId: "a-3", targetTicketId: "a-1" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "cycle",
          relationType: "depends_on",
        }),
      }),
    );
    expect(() =>
      add(
        store,
        relationship({ sourceTicketId: "a-3", targetTicketId: "a-2" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ kind: "cycle" }),
      }),
    );
  });

  it("rejects hierarchy cycles while permitting arbitrary acyclic depth", () => {
    add(
      store,
      relationship({
        relationType: "parent_child",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      }),
    );
    add(
      store,
      relationship({
        relationType: "parent_child",
        sourceTicketId: "a-2",
        targetTicketId: "a-3",
      }),
    );

    expect(() =>
      add(
        store,
        relationship({
          relationType: "parent_child",
          sourceTicketId: "a-3",
          targetTicketId: "a-1",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "cycle",
          relationType: "parent_child",
        }),
      }),
    );
  });

  it("allows cross-project dependencies but rejects cross-project hierarchy", () => {
    expect(() =>
      add(
        store,
        relationship({ sourceTicketId: "a-1", targetTicketId: "b-1" }),
      ),
    ).not.toThrow();

    expect(() =>
      add(
        store,
        relationship({
          relationType: "parent_child",
          sourceTicketId: "a-1",
          targetTicketId: "b-2",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ kind: "scope" }),
      }),
    );
  });
});

describe("relationship mutations and lookup helpers", () => {
  it("edits and clears rationale without changing relationship identity", () => {
    const initial = relationship({ id: "editable" });
    add(store, initial);

    expect(
      store.updateDescription(
        initial.id,
        "Updated **Markdown**",
        timestamp(50),
      ),
    ).toMatchObject({
      id: initial.id,
      description: "Updated **Markdown**",
      createdAt: initial.createdAt,
      updatedAt: timestamp(50),
    });
    expect(
      store.updateDescription(initial.id, "", timestamp(51)),
    ).toMatchObject({ description: "" });
    expect(store.updateDescription("missing", "", timestamp(52))).toBeNull();
  });

  it("returns and removes a canonical row by id", () => {
    const initial = relationship({ id: "removable" });
    add(store, initial);

    expect(store.remove(initial.id)).toEqual(initial);
    expect(store.remove(initial.id)).toBeNull();
    expect(store.getForTicket("a-1", initial.id)).toBeNull();
  });

  it("resolves every legacy alias only from its recorded anchor", () => {
    const initial = relationship({
      id: "canonical",
      relationType: "related",
      sourceTicketId: "a-1",
      targetTicketId: "a-2",
    });
    add(store, initial);
    db.prepare(
      `INSERT INTO ticket_relationship_legacy_aliases
         (legacy_attachment_id, relationship_id, anchor_ticket_id)
       VALUES ('legacy-a', 'canonical', 'a-1'),
              ('legacy-b', 'canonical', 'a-2')`,
    ).run();

    expect(store.resolveLegacyAliasForTicket("a-1", "legacy-a")).toMatchObject({
      id: "canonical",
      role: "related",
      otherTicket: { id: "a-2" },
    });
    expect(store.resolveLegacyAliasForTicket("a-2", "legacy-b")).toMatchObject({
      id: "canonical",
      otherTicket: { id: "a-1" },
    });
    expect(store.resolveLegacyAliasForTicket("a-2", "legacy-a")).toBeNull();
  });

  it("returns deduplicated neighbor and cross-project neighbor ids", () => {
    add(
      store,
      relationship({
        relationType: "related",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      }),
    );
    add(store, relationship({ sourceTicketId: "a-1", targetTicketId: "b-1" }));
    add(
      store,
      relationship({
        relationType: "related",
        sourceTicketId: "a-1",
        targetTicketId: "b-1",
      }),
    );

    expect(store.listNeighborTicketIds("a-1")).toEqual(["a-2", "b-1"]);
    expect(store.listExternalNeighborTicketIds(ALPHA)).toEqual(["b-1"]);
    expect(store.listExternalNeighborTicketIds(BETA)).toEqual(["a-1"]);
  });

  it("rejects a persisted rationale outside the public 256 KiB schema", () => {
    const initial = relationship({ id: "bounded" });
    add(store, initial);

    expect(() =>
      store.updateDescription(initial.id, "é".repeat(131_073), timestamp(40)),
    ).toThrow();
    expect(store.getForTicket("a-1", initial.id)?.description).toBe(
      initial.description,
    );
  });

  it("fails closed when a stored row cannot decode through the public view schema", () => {
    const initial = relationship({ id: "corrupt" });
    add(store, initial);
    db.prepare(
      "UPDATE ticket_relationships SET description = ? WHERE id = ?",
    ).run("é".repeat(131_073), initial.id);

    expect(() => store.getForTicket("a-1", initial.id)).toThrow(
      PersistenceError,
    );
  });
});

describe("role-filtered keyset pagination", () => {
  it("walks same-timestamp rows without gaps or duplicates", () => {
    const sameTimestamp = timestamp(100);
    const expectedIds = ["page-5", "page-4", "page-3", "page-2", "page-1"];
    for (let index = 1; index <= 5; index += 1) {
      add(
        store,
        relationship({
          id: `page-${index}`,
          sourceTicketId: "a-1",
          targetTicketId: `a-${index + 1}`,
          createdAt: sameTimestamp,
          updatedAt: sameTimestamp,
        }),
      );
    }
    add(
      store,
      relationship({
        id: "unfiltered-block",
        sourceTicketId: "a-8",
        targetTicketId: "a-1",
        updatedAt: timestamp(200),
      }),
    );

    const seen: string[] = [];
    let cursor;
    do {
      const page = store.listForTicket("a-1", {
        role: "depends_on",
        limit: 2,
        cursor,
      });
      expect(page.total).toBe(5);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor
        ? (decodeTicketKeysetCursor(page.nextCursor) ?? undefined)
        : undefined;
      if (page.nextCursor !== null) expect(cursor).toBeDefined();
    } while (cursor !== undefined);

    expect(seen).toEqual(expectedIds);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("paginates the unfiltered relative view newest-first", () => {
    const oldest = relationship({
      id: "old-related",
      relationType: "related",
      sourceTicketId: "a-1",
      targetTicketId: "a-2",
      updatedAt: timestamp(10),
    });
    const newest = relationship({
      id: "new-block",
      sourceTicketId: "a-3",
      targetTicketId: "a-1",
      updatedAt: timestamp(20),
    });
    add(store, oldest);
    add(store, newest);

    const first = store.listForTicket("a-1", { limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(["new-block"]);
    expect(first.total).toBe(2);
    const cursor = decodeTicketKeysetCursor(first.nextCursor ?? "");
    expect(cursor).not.toBeNull();
    const second = store.listForTicket("a-1", {
      limit: 1,
      cursor: cursor ?? undefined,
    });
    expect(second.items.map((item) => item.id)).toEqual(["old-related"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("cascades, independent connections, and durability", () => {
  it("deleting a parent leaves its former child parentless", () => {
    add(
      store,
      relationship({
        id: "parent-edge",
        relationType: "parent_child",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      }),
    );

    db.prepare("DELETE FROM tickets WHERE id = 'a-1'").run();

    expect(store.listAllForTicket("a-2")).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM ticket_relationships").get(),
    ).toEqual({ n: 0 });
  });

  it("converts duplicate writes from independent connections to a typed conflict", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-ticket-rel-race-"));
    const dbPath = path.join(tempDir, "state.db");
    let firstDb: Db | undefined;
    let secondDb: Db | undefined;
    try {
      firstDb = _createTestDbAtPath(dbPath);
      seedTickets(firstDb);
      secondDb = _createTestDbAtPath(dbPath);
      const firstStore = createTicketRelationshipsStore(firstDb);
      const secondStore = createTicketRelationshipsStore(secondDb);
      const first = relationship({ id: "connection-one" });
      firstDb.transaction(() => firstStore.add(first)).immediate();

      expect(() =>
        secondDb!
          .transaction(() =>
            secondStore.add(relationship({ id: "connection-two" })),
          )
          .immediate(),
      ).toThrowError(
        expect.objectContaining({
          failure: { kind: "duplicate", relationshipId: "connection-one" },
        }),
      );
    } finally {
      secondDb?.close();
      firstDb?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retains canonical rows, relative order, and aliases after reopening SQLite", () => {
    const tempDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-ticket-rel-durable-"),
    );
    const dbPath = path.join(tempDir, "state.db");
    let writer: Db | undefined;
    let reader: Db | undefined;
    try {
      writer = _createTestDbAtPath(dbPath);
      seedTickets(writer);
      const writerStore = createTicketRelationshipsStore(writer);
      const first = relationship({
        id: "durable-related",
        relationType: "related",
        sourceTicketId: "a-1",
        targetTicketId: "a-2",
      });
      const second = relationship({
        id: "durable-dependency",
        sourceTicketId: "a-1",
        targetTicketId: "b-1",
      });
      writer.transaction(() => writerStore.add(first)).immediate();
      writer.transaction(() => writerStore.add(second)).immediate();
      writer
        .prepare(
          `INSERT INTO ticket_relationship_legacy_aliases
             (legacy_attachment_id, relationship_id, anchor_ticket_id)
           VALUES ('durable-legacy', 'durable-related', 'a-1')`,
        )
        .run();
      writer.close();
      writer = undefined;

      reader = _createTestDbAtPath(dbPath);
      const readerStore = createTicketRelationshipsStore(reader);
      expect(
        readerStore.listAllForTicket("a-1").map((item) => item.id),
      ).toEqual(["durable-dependency", "durable-related"]);
      expect(
        readerStore.resolveLegacyAliasForTicket("a-1", "durable-legacy"),
      ).toMatchObject({
        id: "durable-related",
        description: first.description,
      });
    } finally {
      reader?.close();
      writer?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
