import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import {
  memoryDeliveryWatermarkSchema,
  memoryIndexDeliveryStateSchema,
  memoryObservationCounterSchema,
  type MemoryNote,
} from "@/lib/memory/schemas";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  createMemoryRepo,
  type CreateMemoryNoteInput,
  type MemoryRepo,
} from "./memory-repo";
import {
  createMemoryTelemetryRepo,
  type MemoryTelemetryRepo,
} from "./memory-telemetry-repo";
import { createProjectsRepo } from "./projects-repo";
import { _createTestDb } from "./state-db";
import { createWriteQueue, type WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T11:00:00.000Z";
const T3 = "2026-09-01T12:00:00.000Z";

let db: Db;
let queue: WriteQueue;
let memory: MemoryRepo;
let telemetry: MemoryTelemetryRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  memory = createMemoryRepo(db, queue);
  telemetry = createMemoryTelemetryRepo(db, queue);
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  idSeq = 0;
});

afterEach(() => {
  db.close();
});

/**
 * A second repo over the same database — the post-restart reader. Every
 * durability claim reloads through this rather than the writer instance, so a
 * value held in the writer's memory cannot stand in for a persisted one.
 */
function reader(): MemoryTelemetryRepo {
  return createMemoryTelemetryRepo(db, queue);
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

async function createNote(
  overrides: Partial<CreateMemoryNoteInput> = {},
): Promise<MemoryNote> {
  const input: CreateMemoryNoteInput = {
    id: nextId("mem"),
    revisionId: nextId("rev"),
    slug: nextId("slug"),
    scope: "project",
    projectPath: PROJECT_PATH,
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "Telemetry never feeds ranking",
    body: "Counters are observations.",
    statusNote: null,
    aliases: [],
    indexMode: "auto",
    lifecycle: "active",
    reviewAfter: null,
    expiresAt: null,
    createdBy: "user",
    authorConversationId: null,
    supersedes: null,
    createdAt: T1,
    ...overrides,
  };
  const created = await memory.create(input);
  if (created.status !== "created") {
    throw new Error(`expected create to succeed, got ${created.status}`);
  }
  return created.note;
}

describe("recording delivery watermarks", () => {
  it("persists the delivered revision per conversation, note, and channel", async () => {
    const note = await createNote();

    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: false,
        },
      ],
      deliveredAt: T2,
    });

    expect(await reader().listDeliveryWatermarks("conversation-1")).toEqual([
      {
        conversationId: "conversation-1",
        memoryId: note.id,
        channel: "index",
        revision: 1,
        statusDelivered: false,
        updatedAt: T2,
      },
    ]);
  });

  it("persists whether each delivered note carried its status line", async () => {
    const withStatus = await createNote();
    const withheldStatus = await createNote();

    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: withStatus.id,
          revision: withStatus.revision,
          statusDelivered: true,
        },
        {
          memoryId: withheldStatus.id,
          revision: withheldStatus.revision,
          statusDelivered: false,
        },
      ],
      deliveredAt: T2,
    });

    expect(
      (await reader().listDeliveryWatermarks("conversation-1")).map(
        (watermark) => [watermark.memoryId, watermark.statusDelivered] as const,
      ),
    ).toEqual([
      [withStatus.id, true],
      [withheldStatus.id, false],
    ]);
  });

  it("upserts, so a conversation holds one row per note and channel", async () => {
    const note = await createNote();
    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [{ memoryId: note.id, revision: 1, statusDelivered: true }],
      deliveredAt: T1,
    });

    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [{ memoryId: note.id, revision: 4, statusDelivered: false }],
      deliveredAt: T2,
    });

    const reloaded = await reader().listDeliveryWatermarks("conversation-1");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.revision).toBe(4);
    expect(reloaded[0]?.updatedAt).toBe(T2);
    // The status flag moves with the rest of the row: a status line withheld
    // since the last delivery is a transition the next delta must report, and
    // a conflict clause that left the old flag standing would hide it.
    expect(reloaded[0]?.statusDelivered).toBe(false);
  });

  it("keeps the ambient and expanded channels apart for one note", async () => {
    const note = await createNote();
    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: 1,
          statusDelivered: false,
        },
      ],
      deliveredAt: T1,
    });
    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "expanded",
      notes: [
        {
          memoryId: note.id,
          revision: 1,
          statusDelivered: false,
        },
      ],
      deliveredAt: T2,
    });

    expect(
      (await reader().listDeliveryWatermarks("conversation-1")).map(
        (watermark) => watermark.channel,
      ),
    ).toEqual(["index", "expanded"]);
  });

  it("keeps each conversation's watermark for the same note separate", async () => {
    const note = await createNote();
    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: 1,
          statusDelivered: false,
        },
      ],
      deliveredAt: T1,
    });
    await telemetry.recordDeliveries({
      conversationId: "conversation-2",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: 3,
          statusDelivered: false,
        },
      ],
      deliveredAt: T2,
    });

    expect(
      (await reader().listDeliveryWatermarks("conversation-1"))[0]?.revision,
    ).toBe(1);
    expect(
      (await reader().listDeliveryWatermarks("conversation-2"))[0]?.revision,
    ).toBe(3);
  });

  it("skips a vanished note instead of raising a constraint", async () => {
    const note = await createNote();

    const recorded = await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: 1,
          statusDelivered: false,
        },
        {
          memoryId: "mem-that-was-deleted",
          revision: 1,
          statusDelivered: false,
        },
      ],
      deliveredAt: T1,
    });

    expect(recorded.map((watermark) => watermark.memoryId)).toEqual([note.id]);
  });

  it("drops a note's watermarks when the note is deleted", async () => {
    const note = await createNote();
    await telemetry.recordDeliveries({
      conversationId: "conversation-1",
      channel: "index",
      notes: [
        {
          memoryId: note.id,
          revision: 1,
          statusDelivered: false,
        },
      ],
      deliveredAt: T1,
    });

    await memory.delete(note.id);

    expect(await reader().listDeliveryWatermarks("conversation-1")).toEqual([]);
  });
});

describe("observation counters", () => {
  it("raises one aggregate row per kind and note rather than appending", async () => {
    const note = await createNote();

    await telemetry.observe({
      kind: "retrieval_index",
      memoryIds: [note.id],
      observedAt: T1,
    });
    await telemetry.observe({
      kind: "retrieval_index",
      memoryIds: [note.id],
      observedAt: T2,
    });

    expect(
      await reader().listObservations({ kind: "retrieval_index" }),
    ).toEqual([
      {
        id: `retrieval_index:${note.id}`,
        kind: "retrieval_index",
        memoryId: note.id,
        count: 2,
        firstObservedAt: T1,
        lastObservedAt: T2,
      },
    ]);
  });

  it("counts a note named twice in one batch once", async () => {
    const note = await createNote();

    await telemetry.observe({
      kind: "retrieval_expanded",
      memoryIds: [note.id, note.id],
      observedAt: T1,
    });

    expect(
      (await reader().listObservations({ memoryId: note.id }))[0]?.count,
    ).toBe(1);
  });

  it("collapses every unattributed observation of a kind onto one row", async () => {
    await telemetry.observe({
      kind: "validator_rederivation",
      memoryIds: [null],
      observedAt: T1,
    });
    await telemetry.observe({
      kind: "validator_rederivation",
      memoryIds: [null],
      observedAt: T2,
    });

    const reloaded = await reader().listObservations({
      kind: "validator_rederivation",
    });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.memoryId).toBeNull();
    expect(reloaded[0]?.count).toBe(2);
  });

  it("keeps kinds apart for the same note and orders by count", async () => {
    const note = await createNote();
    await telemetry.observe({
      kind: "retrieval_index",
      memoryIds: [note.id],
      observedAt: T1,
    });
    await telemetry.observe({
      kind: "promotion_candidate",
      memoryIds: [note.id],
      observedAt: T2,
    });
    await telemetry.observe({
      kind: "promotion_candidate",
      memoryIds: [note.id],
      observedAt: T3,
    });

    expect(
      (await reader().listObservations({ memoryId: note.id })).map(
        (counter) => [counter.kind, counter.count] as const,
      ),
    ).toEqual([
      ["promotion_candidate", 2],
      ["retrieval_index", 1],
    ]);
  });

  it("skips a vanished note and drops a deleted note's counters", async () => {
    const note = await createNote();
    const observed = await telemetry.observe({
      kind: "promoted",
      memoryIds: [note.id, "mem-that-was-deleted"],
      observedAt: T1,
    });
    expect(observed.map((counter) => counter.memoryId)).toEqual([note.id]);

    await memory.delete(note.id);

    expect(await reader().listObservations()).toEqual([]);
  });
});

// The delta's other half: watermarks say what each NOTE last carried, and this
// row says when the conversation last received a block at all and when it last
// received a full one. Both are read before composition; neither is ever read
// back into ranking.
describe("index delivery state", () => {
  it("has no state until the conversation is delivered a block", async () => {
    expect(await reader().getIndexDeliveryState("conversation-1")).toBeNull();
  });

  it("records the composition instant of the first full block", async () => {
    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "full",
      at: T1,
    });

    expect(await reader().getIndexDeliveryState("conversation-1")).toEqual({
      conversationId: "conversation-1",
      lastFullAt: T1,
      lastDeliveryAt: T1,
      updatedAt: T1,
    });
  });

  it("advances only the delivery instant when the turn carried a delta", async () => {
    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "full",
      at: T1,
    });

    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "delta",
      at: T2,
    });

    // The next delta is computed against the last DELIVERY, while the full
    // instant stays where the block the conversation still holds was composed.
    expect(await reader().getIndexDeliveryState("conversation-1")).toEqual({
      conversationId: "conversation-1",
      lastFullAt: T1,
      lastDeliveryAt: T2,
      updatedAt: T2,
    });
  });

  it("moves the full instant again when a later turn carries a full block", async () => {
    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "full",
      at: T1,
    });
    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "delta",
      at: T2,
    });

    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "full",
      at: T3,
    });

    expect(await reader().getIndexDeliveryState("conversation-1")).toEqual({
      conversationId: "conversation-1",
      lastFullAt: T3,
      lastDeliveryAt: T3,
      updatedAt: T3,
    });
  });

  it("keeps each conversation's state to itself", async () => {
    await telemetry.markIndexDelivery({
      conversationId: "conversation-1",
      kind: "full",
      at: T1,
    });

    expect(await reader().getIndexDeliveryState("conversation-2")).toBeNull();
  });
});

describe("round-trip durability", () => {
  it("preserves every persisted watermark field across a reload", async () => {
    const note = await createNote();

    await assertRoundTripDurability({
      label: "memory-delivery-watermarks",
      schema: memoryDeliveryWatermarkSchema,
      buildMaximalFixture: () =>
        memoryDeliveryWatermarkSchema.parse({
          conversationId: "conversation-maximal",
          memoryId: note.id,
          channel: "expanded",
          revision: 7,
          statusDelivered: true,
          updatedAt: "2026-04-17T10:11:12.000Z",
        }),
      persist: async (fixture) => {
        const recorded = await telemetry.recordDeliveries({
          conversationId: fixture.conversationId,
          channel: fixture.channel,
          notes: [
            {
              memoryId: fixture.memoryId,
              revision: fixture.revision,
              statusDelivered: fixture.statusDelivered,
            },
          ],
          deliveredAt: fixture.updatedAt,
        });
        const first = recorded[0];
        if (first === undefined) {
          throw new Error("expected the watermark to persist");
        }
        return first;
      },
      reload: async (expected) =>
        (await reader().listDeliveryWatermarks(expected.conversationId))[0] ??
        null,
    });
  });

  it("preserves every persisted counter field across a reload", async () => {
    const note = await createNote();

    await assertRoundTripDurability({
      label: "memory-observation-counters",
      schema: memoryObservationCounterSchema,
      buildMaximalFixture: () =>
        memoryObservationCounterSchema.parse({
          id: `promoted:${note.id}`,
          kind: "promoted",
          memoryId: note.id,
          count: 1,
          firstObservedAt: "2026-04-17T10:11:12.000Z",
          lastObservedAt: "2026-04-17T10:11:12.000Z",
        }),
      persist: async (fixture) => {
        const observed = await telemetry.observe({
          kind: fixture.kind,
          memoryIds: [fixture.memoryId],
          observedAt: fixture.firstObservedAt,
        });
        const first = observed[0];
        if (first === undefined) {
          throw new Error("expected the counter to persist");
        }
        return first;
      },
      reload: async (expected) =>
        (await reader().listObservations({ kind: expected.kind }))[0] ?? null,
    });
  });

  it("preserves both delivery instants of the index state across a reload", async () => {
    await assertRoundTripDurability({
      label: "memory-index-delivery-state",
      schema: memoryIndexDeliveryStateSchema,
      // Deliberately three distinct instants: a fixture whose full and
      // delivery instants matched would pass with the two columns swapped.
      buildMaximalFixture: () =>
        memoryIndexDeliveryStateSchema.parse({
          conversationId: "conversation-maximal",
          lastFullAt: "2026-04-17T10:11:12.000Z",
          lastDeliveryAt: "2026-04-18T13:14:15.000Z",
          updatedAt: "2026-04-18T13:14:15.000Z",
        }),
      persist: async (fixture) => {
        await telemetry.markIndexDelivery({
          conversationId: fixture.conversationId,
          kind: "full",
          at: fixture.lastFullAt,
        });
        const marked = await telemetry.markIndexDelivery({
          conversationId: fixture.conversationId,
          kind: "delta",
          at: fixture.lastDeliveryAt,
        });
        return marked;
      },
      reload: async (expected) =>
        await reader().getIndexDeliveryState(expected.conversationId),
    });
  });
});

// Reset is the context-loss act: the conversation's index history goes, and
// nothing else does. Proven against the production DDL through the persistence
// fixture rather than a fake, because "deletes only these rows" is a claim
// about SQL and cascades, not about a function call.
describe("resetting a conversation's index delivery", () => {
  it("clears the index watermarks and the state row and nothing else", async () => {
    const fixture = createPersistenceFixture();
    try {
      const fixtureQueue = createWriteQueue();
      const notes = createMemoryRepo(fixture.db, fixtureQueue);
      const observations = createMemoryTelemetryRepo(fixture.db, fixtureQueue);
      createProjectsRepo(fixture.db).upsert({ rootPath: PROJECT_PATH });
      const created = await notes.create({
        id: "mem-reset",
        revisionId: "rev-reset",
        slug: "slug-reset",
        scope: "project",
        projectPath: PROJECT_PATH,
        sessionName: null,
        sessionCreatedAt: null,
        kind: "lesson",
        hook: "A hook the reset must not delete",
        body: "",
        statusNote: null,
        aliases: [],
        indexMode: "auto",
        lifecycle: "active",
        reviewAfter: null,
        expiresAt: null,
        createdBy: "user",
        authorConversationId: null,
        supersedes: null,
        createdAt: T1,
      });
      if (created.status !== "created") {
        throw new Error(`expected create to succeed, got ${created.status}`);
      }
      const memoryId = created.note.id;

      for (const conversationId of ["conversation-1", "conversation-2"]) {
        for (const channel of ["index", "expanded"] as const) {
          await observations.recordDeliveries({
            conversationId,
            channel,
            notes: [{ memoryId, revision: 1, statusDelivered: true }],
            deliveredAt: T1,
          });
        }
        await observations.markIndexDelivery({
          conversationId,
          kind: "full",
          at: T1,
        });
      }
      await observations.observe({
        kind: "retrieval_index",
        memoryIds: [memoryId],
        observedAt: T1,
      });

      await observations.resetIndexDelivery("conversation-1");

      // Read back through a second repo over the same database.
      const reloaded = createMemoryTelemetryRepo(fixture.db, fixtureQueue);
      expect(
        (await reloaded.listDeliveryWatermarks("conversation-1")).map(
          (watermark) => watermark.channel,
        ),
      ).toEqual(["expanded"]);
      expect(await reloaded.getIndexDeliveryState("conversation-1")).toBeNull();

      expect(
        (await reloaded.listDeliveryWatermarks("conversation-2"))
          .map((watermark) => watermark.channel)
          .sort(),
      ).toEqual(["expanded", "index"]);
      expect(
        await reloaded.getIndexDeliveryState("conversation-2"),
      ).not.toBeNull();
      expect(
        (await reloaded.listObservations({ memoryId })).map(
          (counter) => counter.count,
        ),
      ).toEqual([1]);
      expect(await notes.find(memoryId)).not.toBeNull();
    } finally {
      fixture.close();
    }
  });

  it("is a no-op for a conversation that was never delivered a block", async () => {
    await expect(
      telemetry.resetIndexDelivery("conversation-never-seen"),
    ).resolves.toBeUndefined();
  });
});
