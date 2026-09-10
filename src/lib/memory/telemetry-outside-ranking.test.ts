// @vitest-inputs src/lib/memory/*.ts
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { PublishFn } from "@/lib/events/publication";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import {
  createMemoryTelemetryRepo,
  type MemoryTelemetryRepo,
} from "@/lib/state-store/memory-telemetry-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createMemoryFreshnessEngine } from "./freshness";
import {
  createMemoryIndexComposer,
  type MemoryIndexComposer,
  type MemoryIndexComposerDeps,
  type MemoryIndexSubject,
} from "./index-composer";
import {
  createMemoryRecallService,
  type MemoryRecallDeps,
  type MemoryRecallService,
} from "./recall";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  type MemoryActor,
  type MemoryIndexBudget,
  type MemoryNote,
} from "./schemas";
import { createMemoryService, type MemoryService } from "./service";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "./telemetry";
import { openMemoryContributionGate } from "./testing/contribution-gate";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const CONVERSATION = "conv-1";
const NOW = "2026-09-02T10:00:00.000Z";
const BUDGET: MemoryIndexBudget = {
  bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
};

const USER_IN_PROJECT: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: null },
};
const PROJECT_SUBJECT: MemoryIndexSubject = {
  conversation: { kind: "project" },
  visibility: USER_IN_PROJECT.visibility,
  activeArtifacts: [],
  delivery: "ambient",
};

let db: Db;
let repo: MemoryRepo;
let telemetryRepo: MemoryTelemetryRepo;
let telemetry: MemoryTelemetryService;
let service: MemoryService;
let composer: MemoryIndexComposer;
let recall: MemoryRecallService;
let idSeq = 0;

const publish: PublishFn = () => ({ delivered: true });

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  telemetryRepo = createMemoryTelemetryRepo(db, queue);
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  idSeq = 0;
  const sessions = {
    async isSessionIncarnationOver() {
      return false;
    },
  };
  service = createMemoryService({
    repo,
    publish,
    contributionGate: openMemoryContributionGate(),
    sessions,
    now: () => NOW,
    generateId: () => {
      idSeq += 1;
      return `a1b2c3d4-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
    },
  });
  const freshness = createMemoryFreshnessEngine({
    repo,
    sessions,
    now: () => NOW,
  });
  composer = createMemoryIndexComposer({ repo, freshness, now: () => NOW });
  recall = createMemoryRecallService({ repo, freshness, now: () => NOW });
  telemetry = createMemoryTelemetryService({
    repo: telemetryRepo,
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
});

async function createNote(hook: string, body: string): Promise<MemoryNote> {
  const created = await service.create(
    { scope: "project", kind: "lesson", hook, body },
    USER_IN_PROJECT,
  );
  if (!created.ok) {
    throw new Error(`create refused: ${created.error.code}`);
  }
  return created.value.note;
}

// ---------------------------------------------------------------------------
// The dependency surfaces of the two selection entry points
// ---------------------------------------------------------------------------

/**
 * Every dependency the composer and the recall ranker accept, named
 * exhaustively. `Record<keyof Deps, true>` makes a NEW dependency on either
 * entry point a compile error here rather than a silent widening: whoever adds
 * one has to come to this file and state that it carries no observation.
 */
const COMPOSER_DEP_NAMES: Record<keyof MemoryIndexComposerDeps, true> = {
  repo: true,
  freshness: true,
  now: true,
};
const RECALL_DEP_NAMES: Record<keyof MemoryRecallDeps, true> = {
  repo: true,
  freshness: true,
  providers: true,
  now: true,
  // A write-only sink for R15.2's recall line. It is handed observations; it
  // hands none back, so nothing it receives can reach a ranking decision.
  logger: true,
};

/** The vocabulary an observation would arrive under, whatever it were called. */
const TELEMETRY_WORDS =
  /telemetry|observ|watermark|retriev|count|popular|frequen|promoted/i;

describe("the selection entry points cannot receive an observation", () => {
  it("accepts only the store, the freshness gate, and the clock", () => {
    expect(Object.keys(COMPOSER_DEP_NAMES).sort()).toEqual([
      "freshness",
      "now",
      "repo",
    ]);
    expect(Object.keys(RECALL_DEP_NAMES).sort()).toEqual([
      "freshness",
      "logger",
      "now",
      "providers",
      "repo",
    ]);
    for (const name of [
      ...Object.keys(COMPOSER_DEP_NAMES),
      ...Object.keys(RECALL_DEP_NAMES),
    ]) {
      expect(name).not.toMatch(TELEMETRY_WORDS);
    }
  });

  it("hands ranking a note store that shares no method with the observation store", () => {
    const rankingReach = new Set(Object.keys(repo));
    const observations = Object.keys(telemetryRepo);

    expect(observations.length).toBeGreaterThan(0);
    for (const method of observations) {
      expect(rankingReach.has(method)).toBe(false);
    }
    // And nothing on the note store is named like an observation either — the
    // separation is a property of the interface, not of who happens to call it.
    for (const method of rankingReach) {
      expect(method).not.toMatch(TELEMETRY_WORDS);
    }
  });

  it("imports no telemetry module into any selection or freshness path", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const file of [
      "index-composer.ts",
      "recall.ts",
      "recall-providers.ts",
      "freshness.ts",
    ]) {
      const source = readFileSync(path.join(here, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)].map(
        (match) => match[1] ?? "",
      );
      expect(
        imports.filter((specifier) => /telemetry/u.test(specifier)),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural proof: counters move, output does not
// ---------------------------------------------------------------------------

describe("changing the counters changes no delivered output", () => {
  it("leaves the index block and the recall pack byte-identical", async () => {
    const first = await createNote(
      "swap thrash reads as an onTaskUpdate timeout",
      "Zero test failures plus a timeout is swap thrash, not a branch defect.",
    );
    const second = await createNote(
      "the FTS index is derived and rebuildable",
      "A rebuild repopulates the search index from the note rows.",
    );

    const blockBefore = await composer.compose(PROJECT_SUBJECT, BUDGET);
    const packBefore = await recall.recall(
      { query: "swap thrash rebuild" },
      USER_IN_PROJECT,
    );
    expect(blockBefore).not.toBeNull();
    expect(packBefore.ok).toBe(true);

    // Make the SECOND note overwhelmingly the most retrieved, promoted, and
    // re-derived record in the library. Under any popularity-fed ranking this
    // would move it; under this one there is nothing to move.
    for (let round = 0; round < 25; round += 1) {
      await telemetry.recordDelivery({
        conversationId: CONVERSATION,
        channel: "index",
        // Alternating so the delivery state churns too: the full instant, the
        // delivery instant, and the watermarks all move 25 times under a
        // composer that cannot read any of them.
        kind: round === 0 ? "full" : "delta",
        composedAt: `2026-09-02T10:${String(round).padStart(2, "0")}:00.000Z`,
        notes: [
          {
            memoryId: second.id,
            revision: second.revision,
            statusDelivered: false,
          },
        ],
      });
      await telemetry.recordDelivery({
        conversationId: CONVERSATION,
        channel: "expanded",
        notes: [
          {
            memoryId: second.id,
            revision: second.revision,
            statusDelivered: false,
          },
        ],
      });
      await telemetry.recordPromotionCandidates([second.id]);
      await telemetry.recordPromoted(second.id);
      await telemetry.recordValidatorRederivation({ memoryId: second.id });
    }

    // The counters really did move — otherwise this test would pass vacuously.
    expect(
      (await telemetry.listObservations({ memoryId: second.id })).map(
        (counter) => [counter.kind, counter.count] as const,
      ),
    ).toEqual(
      expect.arrayContaining([
        ["retrieval_index", 25],
        ["retrieval_expanded", 25],
        ["promotion_candidate", 25],
        ["promoted", 25],
        ["validator_rederivation", 25],
      ]),
    );
    expect(await telemetry.listObservations({ memoryId: first.id })).toEqual(
      [],
    );
    // And the delivery state moved as well, so the byte-identical block below
    // is not the accident of a store that never changed.
    expect(
      (await telemetry.readIndexDelivery(CONVERSATION)).state?.lastDeliveryAt,
    ).toBe("2026-09-02T10:24:00.000Z");

    const blockAfter = await composer.compose(PROJECT_SUBJECT, BUDGET);
    const packAfter = await recall.recall(
      { query: "swap thrash rebuild" },
      USER_IN_PROJECT,
    );

    expect(blockAfter?.text).toBe(blockBefore?.text);
    expect(blockAfter?.entries).toEqual(blockBefore?.entries);
    if (!packBefore.ok || !packAfter.ok) {
      throw new Error("expected both recalls to succeed");
    }
    expect(packAfter.value.text).toBe(packBefore.value.text);
    expect(packAfter.value.entries.map((entry) => entry.note.slug)).toEqual(
      packBefore.value.entries.map((entry) => entry.note.slug),
    );
  });
});

// ---------------------------------------------------------------------------
// The observations themselves are recorded and readable
// ---------------------------------------------------------------------------

describe("recording the observations R15 gathers", () => {
  it("counts retrievals per note and per channel from the delivery seams", async () => {
    const note = await createNote("a hook", "a body");

    await telemetry.recordDelivery({
      conversationId: CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: NOW,
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
      channel: "expanded",
      notes: [
        {
          memoryId: note.id,
          revision: note.revision,
          statusDelivered: false,
        },
      ],
    });

    expect(
      (await telemetry.listObservations({ memoryId: note.id })).map(
        (counter) => counter.kind,
      ),
    ).toEqual(
      expect.arrayContaining(["retrieval_index", "retrieval_expanded"]),
    );
  });

  it("keeps promotion candidates and promotions apart on the same note", async () => {
    const note = await createNote("a promotable hook", "a body");

    await telemetry.recordPromotionCandidates([note.id]);
    await telemetry.recordPromotionCandidates([note.id]);
    await telemetry.recordPromoted(note.id);

    const counters = await telemetry.listObservations({ memoryId: note.id });
    expect(
      counters.find((counter) => counter.kind === "promotion_candidate")?.count,
    ).toBe(2);
    expect(counters.find((counter) => counter.kind === "promoted")?.count).toBe(
      1,
    );
  });

  it("records an unattributed validator re-derivation without a note", async () => {
    await telemetry.recordValidatorRederivation({});

    expect(
      await telemetry.listObservations({ kind: "validator_rederivation" }),
    ).toEqual([
      expect.objectContaining({
        kind: "validator_rederivation",
        memoryId: null,
        count: 1,
      }),
    ]);
  });

  it("writes nothing for an empty promotion-candidate set", async () => {
    await telemetry.recordPromotionCandidates([]);

    expect(await telemetry.listObservations()).toEqual([]);
  });
});
