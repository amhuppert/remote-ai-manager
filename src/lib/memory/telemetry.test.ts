import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import {
  createMemoryRepo,
  type CreateMemoryNoteInput,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import { createMemoryTelemetryRepo } from "@/lib/state-store/memory-telemetry-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import type { MemoryNote } from "./schemas";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "./telemetry";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const CONVERSATION = "conv-1";
const T1 = "2026-09-01T10:00:00.000Z";
const COMPOSED_1 = "2026-09-01T09:59:00.000Z";
const COMPOSED_2 = "2026-09-01T10:30:00.000Z";

let db: Db;
let repo: MemoryRepo;
let telemetry: MemoryTelemetryService;
let clock: string;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  clock = T1;
  idSeq = 0;
  telemetry = createMemoryTelemetryService({
    repo: createMemoryTelemetryRepo(db, queue),
    now: () => clock,
  });
});

afterEach(() => {
  db.close();
});

async function createNote(): Promise<MemoryNote> {
  idSeq += 1;
  const input: CreateMemoryNoteInput = {
    id: `mem-${idSeq}`,
    revisionId: `rev-${idSeq}`,
    slug: `slug-${idSeq}`,
    scope: "project",
    projectPath: PROJECT_PATH,
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "Telemetry is an observation",
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
  };
  const created = await repo.create(input);
  if (created.status !== "created") {
    throw new Error(`expected create to succeed, got ${created.status}`);
  }
  return created.note;
}

describe("recording a delivery", () => {
  it("stamps the delivery clock on every note the channel carried", async () => {
    const first = await createNote();
    const second = await createNote();
    clock = "2026-09-02T09:00:00.000Z";

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [
        {
          memoryId: first.id,
          revision: first.revision,
          statusDelivered: true,
        },
        {
          memoryId: second.id,
          revision: second.revision,
          statusDelivered: false,
        },
      ],
    });

    // The status flag the seam stated survives the write per note: the delta
    // that follows reads a withheld-or-restored transition off exactly this.
    expect(await telemetry.listDeliveryWatermarks(CONVERSATION)).toEqual([
      {
        conversationId: CONVERSATION,
        memoryId: first.id,
        channel: "index",
        revision: 1,
        statusDelivered: true,
        updatedAt: "2026-09-02T09:00:00.000Z",
      },
      {
        conversationId: CONVERSATION,
        memoryId: second.id,
        channel: "index",
        revision: 1,
        statusDelivered: false,
        updatedAt: "2026-09-02T09:00:00.000Z",
      },
    ]);
  });

  it("writes no watermark for a delivery that carried no note", async () => {
    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [],
    });

    expect(await telemetry.listDeliveryWatermarks(CONVERSATION)).toEqual([]);
  });

  it("counts the retrieval on what persisted, not on what was handed in", async () => {
    const note = await createNote();

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [
        { memoryId: note.id, revision: note.revision, statusDelivered: false },
        // Deleted between composing the block and this write: it was shown to
        // nobody by the time the row would have said so.
        { memoryId: "mem-vanished", revision: 1, statusDelivered: false },
      ],
    });

    expect(
      (await telemetry.listObservations({ kind: "retrieval_index" })).map(
        (counter) => [counter.memoryId, counter.count] as const,
      ),
    ).toEqual([[note.id, 1]]);
  });

  it("advances the watermark when a later delivery carries a newer revision", async () => {
    const note = await createNote();
    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [{ memoryId: note.id, revision: 1, statusDelivered: false }],
    });

    clock = "2026-09-03T09:00:00.000Z";
    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "delta",
      composedAt: COMPOSED_2,
      notes: [{ memoryId: note.id, revision: 2, statusDelivered: false }],
    });

    expect(await telemetry.listDeliveryWatermarks(CONVERSATION)).toEqual([
      {
        conversationId: CONVERSATION,
        memoryId: note.id,
        channel: "index",
        revision: 2,
        statusDelivered: false,
        updatedAt: "2026-09-03T09:00:00.000Z",
      },
    ]);
  });
});

// The delta's read-before-compose seam (R15, D4). Everything here is written by
// the delivering turn and read by the next composition; none of it is reachable
// from selection.
describe("index delivery state through the service", () => {
  it("marks the full block at the instant it was composed, not at settlement", async () => {
    const note = await createNote();
    clock = "2026-09-01T10:00:05.000Z";

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: false,
        },
      ],
    });

    // The state row dates the block by its COMPOSITION, so a note captured
    // between composing the block and the backend accepting the turn is still
    // new to the next delta. The watermark keeps the settlement clock.
    const read = await telemetry.readIndexDelivery(CONVERSATION);
    expect(read.state).toEqual({
      conversationId: CONVERSATION,
      lastFullAt: COMPOSED_1,
      lastDeliveryAt: COMPOSED_1,
      updatedAt: COMPOSED_1,
    });
    expect(read.watermarks.map((watermark) => watermark.updatedAt)).toEqual([
      "2026-09-01T10:00:05.000Z",
    ]);
  });

  it("advances only the delivery instant for a delta", async () => {
    const note = await createNote();
    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: false,
        },
      ],
    });

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "delta",
      composedAt: COMPOSED_2,
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: true,
        },
      ],
    });

    const read = await telemetry.readIndexDelivery(CONVERSATION);
    expect(read.state?.lastFullAt).toBe(COMPOSED_1);
    expect(read.state?.lastDeliveryAt).toBe(COMPOSED_2);
    expect(read.watermarks[0]?.statusDelivered).toBe(true);
  });

  it("advances the state for a delta that carried nothing", async () => {
    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: COMPOSED_1,
      notes: [],
    });

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "delta",
      composedAt: COMPOSED_2,
      notes: [],
    });

    // A quiet turn still received a block, and a state row left behind would
    // make the next delta recompute against an instant the conversation has
    // already been told about.
    const read = await telemetry.readIndexDelivery(CONVERSATION);
    expect(read.state?.lastFullAt).toBe(COMPOSED_1);
    expect(read.state?.lastDeliveryAt).toBe(COMPOSED_2);
    expect(read.watermarks).toEqual([]);
  });

  it("leaves the state alone when a recall expanded a pack", async () => {
    const note = await createNote();

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "expanded",
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: true,
        },
      ],
    });

    // A pack the agent asked for is not the ambient block, so it neither
    // starts the conversation's index history nor appears in the delta read.
    const read = await telemetry.readIndexDelivery(CONVERSATION);
    expect(read.state).toBeNull();
    expect(read.watermarks).toEqual([]);
    expect(await telemetry.listDeliveryWatermarks(CONVERSATION)).toHaveLength(
      1,
    );
  });

  it("forgets the index history on a context loss and keeps the rest", async () => {
    const note = await createNote();
    for (const channel of ["index", "expanded"] as const) {
      await telemetry.recordDelivery(
        channel === "index"
          ? {
              conversationId: CONVERSATION,
              channel,
              kind: "full",
              composedAt: COMPOSED_1,
              notes: [
                {
                  memoryId: note.id,
                  revision: note.revision,
                  statusDelivered: true,
                },
              ],
            }
          : {
              conversationId: CONVERSATION,
              channel,
              notes: [
                {
                  memoryId: note.id,
                  revision: note.revision,
                  statusDelivered: true,
                },
              ],
            },
      );
    }

    await telemetry.resetIndexDelivery(CONVERSATION);

    const read = await telemetry.readIndexDelivery(CONVERSATION);
    expect(read.state).toBeNull();
    expect(read.watermarks).toEqual([]);
    expect(
      (await telemetry.listDeliveryWatermarks(CONVERSATION)).map(
        (watermark) => watermark.channel,
      ),
    ).toEqual(["expanded"]);
    // Counters are evaluation history, not delivery state: a context loss the
    // agent lived through does not un-retrieve what it was shown.
    expect(
      (await telemetry.listObservations({ kind: "retrieval_index" }))[0]?.count,
    ).toBe(1);
  });
});
