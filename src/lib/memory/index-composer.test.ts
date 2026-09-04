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
  type MemoryIndexBlock,
  type MemoryIndexComposer,
  type MemoryIndexDeltaBasis,
  type MemoryIndexSubject,
} from "./index-composer";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  MEMORY_INDEX_BUDGET_MIN_BYTES,
  MEMORY_STATUS_NOTE_LEASE_MS,
  memoryBodyByteLength,
  type CreateMemoryNoteRequest,
  type MemoryActor,
  type MemoryIndexBudget,
  type MemoryNote,
} from "./schemas";
import { createMemoryService, type MemoryService } from "./service";
import { openMemoryContributionGate } from "./testing/contribution-gate";
import {
  loadMemoryEvalCorpus,
  seedMemoryEvalCorpus,
} from "./testing/eval-corpus";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
/** The ticket the corpus's status specimen is about-linked to. */
const LINKED_TICKET = "ticket-88";
const ACTIVE_TICKET = "ticket-74";
const ACTIVE_SPEC = "spec-memory";
const ACTIVE_EXECUTION = "exec-1";
const SESSION_NAME = "memory-session";
const SESSION_CREATED_AT = "2026-09-01T09:00:00.000Z";
const BASE_TIME = Date.UTC(2026, 8, 1, 10, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUDGET: MemoryIndexBudget = {
  bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
};

/**
 * The omission line as an instruction (R5.2, D4): the count, then recall
 * first and list second. The evaluation's crowded runs ignored the
 * informational form, so the closing line now tells the agent what to do.
 */
function omissionInstruction(
  shown: number,
  total: number,
  omitted: number,
): string {
  return `showing ${shown} of ${total} hooks — ${omitted} omitted over budget. If this turn touches something not listed above, search first: cctl memory recall '<topic>' (full list: cctl memory list)`;
}

/** Real ids look like UUIDs; the no-id invariant is asserted against this shape. */
const INTERNAL_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

const USER_IN_PROJECT: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: null },
};
const USER_IN_SESSION: MemoryActor = {
  kind: "user",
  visibility: {
    projectPath: PROJECT_PATH,
    session: {
      sessionName: SESSION_NAME,
      sessionCreatedAt: SESSION_CREATED_AT,
    },
  },
};
const AGENT_IN_PROJECT: MemoryActor = {
  kind: "agent",
  conversationId: "conv-agent",
  visibility: { projectPath: PROJECT_PATH, session: null },
};

const PROJECT_SUBJECT: MemoryIndexSubject = {
  conversation: { kind: "project" },
  visibility: USER_IN_PROJECT.visibility,
  activeArtifacts: [],
  delivery: "ambient",
};
const SESSION_SUBJECT: MemoryIndexSubject = {
  conversation: { kind: "session", sessionName: SESSION_NAME },
  visibility: USER_IN_SESSION.visibility,
  activeArtifacts: [{ kind: "ticket", ticketId: ACTIVE_TICKET }],
  delivery: "ambient",
};

let db: Db;
let repo: MemoryRepo;
let telemetry: MemoryTelemetryRepo;
let service: MemoryService;
let composer: MemoryIndexComposer;
let clock: number;
let idSeq: number;

const publish: PublishFn = () => ({ delivered: true });

function now(): string {
  return new Date(BASE_TIME + clock).toISOString();
}

/** UUID-shaped ids, so the text assertions can prove no internal id leaks. */
function nextId(): string {
  idSeq += 1;
  return `a1b2c3d4-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  telemetry = createMemoryTelemetryRepo(db, queue);
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  clock = 0;
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
    now: () => {
      clock += 1000;
      return now();
    },
    generateId: nextId,
  });
  composer = createMemoryIndexComposer({
    repo,
    freshness: createMemoryFreshnessEngine({ repo, sessions, now }),
    now,
  });
});

afterEach(() => {
  db.close();
});

async function seedCorpus(): Promise<Map<string, MemoryNote>> {
  return seedMemoryEvalCorpus({
    service,
    actor: USER_IN_PROJECT,
    linkArtifacts: {
      ticket: { kind: "ticket", ticketId: LINKED_TICKET },
    },
  });
}

async function createNote(
  request: CreateMemoryNoteRequest,
  actor: MemoryActor = USER_IN_PROJECT,
): Promise<MemoryNote> {
  const result = await service.create(request, actor);
  if (!result.ok) {
    throw new Error(
      `create refused: ${result.error.code} ${result.error.message}`,
    );
  }
  return result.value.note;
}

async function compose(
  subject: MemoryIndexSubject,
  budget: MemoryIndexBudget = DEFAULT_BUDGET,
): Promise<MemoryIndexBlock> {
  const block = await composer.compose(subject, budget);
  if (block === null) throw new Error("expected a rendered block");
  return block;
}

const CONVERSATION_ID = "conv-delta";

/**
 * What the turn wiring does once the backend accepts a delivery: record the
 * entries the block actually carried and advance the conversation's delivery
 * state to the block's composition instant. Real rows, so the delta is
 * computed against exactly what the store hands back.
 */
async function settleDelivery(
  block: MemoryIndexBlock,
  at: string,
  overrides: {
    readonly statusDelivered?: Partial<Record<string, boolean>>;
    readonly skip?: readonly string[];
  } = {},
): Promise<void> {
  const notes = block.entries
    .filter((entry) => !(overrides.skip ?? []).includes(entry.slug))
    .map((entry) => ({
      memoryId: entry.memoryId,
      revision: entry.revision,
      statusDelivered:
        overrides.statusDelivered?.[entry.slug] ?? entry.statusDelivered,
    }));
  if (notes.length > 0) {
    await telemetry.recordDeliveries({
      conversationId: CONVERSATION_ID,
      channel: "index",
      notes,
      deliveredAt: at,
    });
  }
  await telemetry.markIndexDelivery({
    conversationId: CONVERSATION_ID,
    kind: block.kind,
    at,
  });
}

/** The read the wiring takes before composing: state plus index-channel watermarks. */
async function readBasis(): Promise<MemoryIndexDeltaBasis> {
  const state = await telemetry.getIndexDeliveryState(CONVERSATION_ID);
  if (state === null) throw new Error("expected a delivered conversation");
  const watermarks = (
    await telemetry.listDeliveryWatermarks(CONVERSATION_ID)
  ).filter((row) => row.channel === "index");
  return { state, watermarks };
}

async function composeDelta(
  subject: MemoryIndexSubject,
  basis?: MemoryIndexDeltaBasis,
  budget: MemoryIndexBudget = DEFAULT_BUDGET,
): Promise<MemoryIndexBlock> {
  return composer.composeDelta(subject, budget, basis ?? (await readBasis()));
}

async function updateNote(
  note: MemoryNote,
  changes: { hook?: string; body?: string; statusNote?: string | null },
): Promise<MemoryNote> {
  const result = await service.update(
    note.slug,
    { baseRevision: note.revision, ...changes },
    USER_IN_PROJECT,
  );
  if (!result.ok) {
    throw new Error(
      `update refused: ${result.error.code} ${result.error.message}`,
    );
  }
  return result.value;
}

/** Procedural filler: enough auto hooks to exceed any tested budget. */
async function seedFiller(
  count: number,
  scope: "project" | "global",
  prefix: string,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await createNote({
      scope,
      kind: "lesson",
      slug: `${prefix}-${String(index).padStart(3, "0")}`,
      hook: `Filler ${prefix} ${index}: a representative one-line lesson hook that costs a realistic number of bytes`,
      body: "Filler body.",
    });
  }
}

describe("budget and omission (R5.2)", () => {
  it("keeps the corpus-seeded block within every tested budget and states what it omitted", async () => {
    await seedCorpus();
    await seedFiller(40, "project", "proj");
    const corpusSlugs = loadMemoryEvalCorpus().notes.map((note) => note.slug);

    for (const bytes of [
      MEMORY_INDEX_BUDGET_MIN_BYTES,
      1536,
      2048,
      3072,
      4096,
      6144,
      12288,
    ]) {
      const block = await compose(PROJECT_SUBJECT, { bytes, hooks: 80 });
      expect(memoryBodyByteLength(block.text)).toBe(block.bytes);
      expect(block.bytes).toBeLessThanOrEqual(bytes);
      expect(block.entries.length + block.omitted).toBe(block.total);
      expect(block.text.startsWith("<memory-index>\n")).toBe(true);
      expect(block.text.endsWith("\n</memory-index>")).toBe(true);
      if (block.omitted > 0) {
        const closing = omissionInstruction(
          block.entries.length,
          block.total,
          block.omitted,
        );
        expect(block.text).toContain(closing);
        // Recall is named before list: the instruction's order is the point.
        expect(closing.indexOf("cctl memory recall")).toBeLessThan(
          closing.indexOf("cctl memory list"),
        );
      } else {
        expect(block.text).toContain(
          `showing ${block.total} of ${block.total} hooks`,
        );
        expect(block.text).not.toContain("over budget");
      }
    }

    // The default budget carries the whole corpus plus the filler.
    const full = await compose(PROJECT_SUBJECT);
    expect(full.omitted).toBe(0);
    for (const slug of corpusSlugs) {
      expect(full.text).toContain(`- ${slug} [project, `);
    }
  });

  it("caps the hook count independently of bytes", async () => {
    await seedFiller(15, "project", "proj");

    const block = await compose(PROJECT_SUBJECT, { bytes: 12288, hooks: 5 });

    expect(block.entries).toHaveLength(5);
    expect(block.omitted).toBe(10);
    expect(block.text).toContain(
      "showing 5 of 15 hooks — 10 omitted over budget. If this turn touches something not listed above, search first: cctl memory recall '<topic>' (full list: cctl memory list)",
    );
  });

  it("never renders an internal memory id in the text", async () => {
    await seedCorpus();

    const block = await compose(PROJECT_SUBJECT);

    expect(block.entries.length).toBeGreaterThan(0);
    expect(block.text).not.toMatch(INTERNAL_ID_PATTERN);
    for (const entry of block.entries) {
      expect(entry.memoryId).toMatch(INTERNAL_ID_PATTERN);
      expect(block.text).not.toContain(entry.memoryId);
    }
  });

  it("returns null when the conversation has nothing to be told", async () => {
    expect(await composer.compose(PROJECT_SUBJECT, DEFAULT_BUDGET)).toBeNull();
  });
});

describe("withholding (R2, R5.2, R9)", () => {
  it("withholds expired, proposed, and review-due records, states each count with its command, and never lists archived notes", async () => {
    await seedCorpus();
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "expired-lesson",
      hook: "An expired lesson that must not prime anyone",
      expiresAt: "2026-09-01T09:00:00.000Z",
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "review-due-lesson",
      hook: "A lesson whose own review lease has passed",
      reviewAfter: "2026-09-01T09:30:00.000Z",
    });
    await createNote(
      {
        scope: "global",
        kind: "lesson",
        slug: "agent-global-proposal",
        hook: "An agent's global note waiting for approval",
      },
      AGENT_IN_PROJECT,
    );
    const archived = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "archived-lesson",
      hook: "An archived lesson",
    });
    const archive = await service.archive(
      archived.slug,
      { baseRevision: archived.revision },
      USER_IN_PROJECT,
    );
    expect(archive.ok).toBe(true);

    const block = await compose(PROJECT_SUBJECT);

    expect(block.withheld).toEqual({ reviewDue: 1, expired: 1, proposed: 1 });
    expect(block.text).toContain(
      "withheld: 1 review-due, 1 expired — cctl memory review; 1 proposed — cctl memory list --lifecycle proposed",
    );
    for (const slug of [
      "expired-lesson",
      "review-due-lesson",
      "agent-global-proposal",
      "archived-lesson",
    ]) {
      expect(block.text).not.toContain(slug);
    }
    // The corpus itself is intact around the withheld records.
    expect(block.text).toContain("- notepad-feature-roadmap [project, ");
  });

  it("delivers a note whose only staleness is its statusNote without the stale line, and a fresh status line with its age", async () => {
    await seedCorpus();
    const specimen = "ticket88-cursor-darwin-status";

    const fresh = await compose(PROJECT_SUBJECT);
    const freshEntry = fresh.entries.find((entry) => entry.slug === specimen);
    expect(freshEntry?.statusDelivered).toBe(true);
    expect(fresh.text).toContain(
      `- ${specimen} [project, just now, +308b] Cursor darwin support derives the SDK package`,
    );
    expect(fresh.text).toContain(
      "  status: ticket-88 work still unmerged (status as of just now)",
    );

    // The status lease lapses and the claim stops being delivered. Nothing
    // observes the ticket: staleness is the lease running out (R2, R8).
    clock += MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS;
    const stale = await compose(PROJECT_SUBJECT);
    const staleEntry = stale.entries.find((entry) => entry.slug === specimen);
    expect(staleEntry?.statusDelivered).toBe(false);
    expect(stale.text).toContain(
      `- ${specimen} [project, 15 days ago, +308b] Cursor darwin`,
    );
    expect(stale.text).not.toContain("ticket-88 work still unmerged");
    // The note itself is not review-due: nothing is withheld at the note level.
    expect(stale.withheld).toEqual({ reviewDue: 0, expired: 0, proposed: 0 });
    expect(stale.text).not.toContain("withheld:");
  });
});

describe("quota reservation (R5.3, R8.2)", () => {
  it("keeps about-linked, session, and always notes in the block ahead of a large auto library, in section order", async () => {
    await seedFiller(45, "project", "proj");
    await seedFiller(45, "global", "glob");
    const linked = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "about-ticket-74",
      hook: "The lesson linked to the active ticket",
    });
    const link = await service.link(
      linked.slug,
      { kind: "about", artifact: { kind: "ticket", ticketId: ACTIVE_TICKET } },
      USER_IN_PROJECT,
    );
    expect(link.ok).toBe(true);
    const specLinked = await createNote({
      scope: "global",
      kind: "procedure",
      slug: "about-spec-memory",
      hook: "The decision linked to the active spec",
    });
    const specLink = await service.link(
      specLinked.slug,
      { kind: "about", artifact: { kind: "spec", specId: ACTIVE_SPEC } },
      USER_IN_PROJECT,
    );
    expect(specLink.ok).toBe(true);
    const executionLinked = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "about-execution-1",
      hook: "The lesson linked to the running workflow execution",
    });
    const executionLink = await service.link(
      executionLinked.slug,
      {
        kind: "about",
        artifact: { kind: "workflow_execution", executionId: ACTIVE_EXECUTION },
      },
      USER_IN_PROJECT,
    );
    expect(executionLink.ok).toBe(true);
    await createNote(
      {
        scope: "session",
        kind: "state",
        slug: "session-working-state",
        hook: "This session's leased working state",
      },
      USER_IN_SESSION,
    );
    await createNote({
      scope: "global",
      kind: "preference",
      slug: "always-preference",
      hook: "A preference its author pinned to every index",
      indexMode: "always",
    });

    const block = await compose(
      {
        ...SESSION_SUBJECT,
        activeArtifacts: [
          { kind: "ticket", ticketId: ACTIVE_TICKET },
          { kind: "spec", specId: ACTIVE_SPEC },
          { kind: "workflow_execution", executionId: ACTIVE_EXECUTION },
        ],
      },
      { bytes: 3072, hooks: 24 },
    );

    expect(block.omitted).toBeGreaterThan(0);
    expect(block.text).toContain(
      "## about ticket:ticket-74, spec:spec-memory, execution:exec-1 (3 of 3)",
    );
    expect(block.text).toContain("- about-ticket-74 [project, ");
    expect(block.text).toContain("- about-spec-memory [global, ");
    expect(block.text).toContain("- about-execution-1 [project, ");
    expect(block.text).toContain("## session (1 of 1)");
    expect(block.text).toContain("- session-working-state [session, ");
    expect(block.text).toContain("## always (1 of 1)");
    expect(block.text).toContain("- always-preference [global, ");
    expect(block.text).toMatch(/## auto \(\d+ of 90\)/u);

    const order = ["## about", "## session", "## always", "## auto"].map(
      (header) => block.text.indexOf(header),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(block.entries.map((entry) => entry.section)).toEqual([
      "about",
      "about",
      "about",
      "session",
      "always",
      ...Array<"auto">(block.entries.length - 5).fill("auto"),
    ]);
  });

  it("orders the auto section project-then-global", async () => {
    await seedFiller(3, "global", "glob");
    await seedFiller(3, "project", "proj");

    const block = await compose(PROJECT_SUBJECT);

    const autoSlugs = block.entries
      .filter((entry) => entry.section === "auto")
      .map((entry) => entry.scope);
    expect(autoSlugs).toEqual([
      "project",
      "project",
      "project",
      "global",
      "global",
      "global",
    ]);
  });

  it("does not let a source link to the active artifact cue the about section", async () => {
    const sourced = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "sourced-from-ticket",
      hook: "A lesson that merely cites the active ticket as a source",
    });
    const link = await service.link(
      sourced.slug,
      { kind: "source", artifact: { kind: "ticket", ticketId: ACTIVE_TICKET } },
      USER_IN_PROJECT,
    );
    expect(link.ok).toBe(true);

    const block = await compose(SESSION_SUBJECT);

    expect(block.entries).toEqual([
      expect.objectContaining({ slug: "sourced-from-ticket", section: "auto" }),
    ]);
    expect(block.text).not.toContain("## about");
  });
});

describe("visibility union and labels (R3)", () => {
  const OTHER_INCARNATION: MemoryActor = {
    kind: "user",
    visibility: {
      projectPath: PROJECT_PATH,
      session: {
        sessionName: SESSION_NAME,
        sessionCreatedAt: "2026-08-01T09:00:00.000Z",
      },
    },
  };

  async function seedScopes(): Promise<void> {
    await createNote({
      scope: "global",
      kind: "preference",
      slug: "global-preference",
      hook: "A global preference",
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "project-lesson",
      hook: "A project lesson",
    });
    await createNote(
      {
        scope: "session",
        kind: "lesson",
        slug: "this-session-lesson",
        hook: "A lesson this incarnation learned",
      },
      USER_IN_SESSION,
    );
    await createNote(
      {
        scope: "session",
        kind: "lesson",
        slug: "earlier-incarnation-lesson",
        hook: "A lesson an earlier session of the same name learned",
      },
      OTHER_INCARNATION,
    );
  }

  it("delivers global and project notes to a project conversation, each labeled with scope and age", async () => {
    await seedScopes();

    const block = await compose(PROJECT_SUBJECT);

    expect(block.entries.map((entry) => entry.slug)).toEqual([
      "project-lesson",
      "global-preference",
    ]);
    expect(block.text).toContain("visibility: global + project\n");
    expect(block.text).toContain(
      "- project-lesson [project, just now] A project lesson",
    );
    expect(block.text).toContain(
      "- global-preference [global, just now] A global preference",
    );
    expect(block.text).not.toContain("session-lesson");
  });

  it("additionally delivers the session's own incarnation notes, never another incarnation's", async () => {
    await seedScopes();

    const block = await compose(SESSION_SUBJECT);

    expect(block.text).toContain(
      `visibility: global + project + session ${SESSION_NAME}\n`,
    );
    expect(block.text).toContain(
      "- this-session-lesson [session, just now] A lesson this incarnation learned",
    );
    expect(block.text).not.toContain("earlier-incarnation-lesson");
    expect(block.entries.map((entry) => entry.slug)).toEqual([
      "this-session-lesson",
      "project-lesson",
      "global-preference",
    ]);
  });

  it("delivers conflicting same-slug notes from different scopes, each labeled", async () => {
    await createNote({
      scope: "global",
      kind: "preference",
      slug: "commit-style",
      hook: "Globally: conventional commits",
    });
    await createNote({
      scope: "project",
      kind: "preference",
      slug: "commit-style",
      hook: "In this project: imperative subject lines, no prefixes",
    });

    const block = await compose(PROJECT_SUBJECT);

    expect(block.text).toContain(
      "- commit-style [project, just now] In this project: imperative subject lines, no prefixes",
    );
    expect(block.text).toContain(
      "- commit-style [global, just now] Globally: conventional commits",
    );
  });
});

describe("linked-only delivery (R10)", () => {
  it("delivers exactly the about-linked notes and nothing from the ambient index", async () => {
    await seedFiller(5, "project", "proj");
    const linked = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "about-ticket-74",
      hook: "The lesson linked to the active ticket",
    });
    const link = await service.link(
      linked.slug,
      { kind: "about", artifact: { kind: "ticket", ticketId: ACTIVE_TICKET } },
      USER_IN_PROJECT,
    );
    expect(link.ok).toBe(true);

    const block = await compose({
      ...SESSION_SUBJECT,
      delivery: "linked-only",
    });

    expect(block.total).toBe(1);
    expect(block.entries).toEqual([
      expect.objectContaining({ slug: "about-ticket-74", section: "about" }),
    ]);
    expect(block.text).toContain("delivery: linked-only");
    expect(block.text).not.toContain("proj-00");
    expect(block.text).not.toContain("## auto");
  });
});

describe("body-size marker (R5.6)", () => {
  it("prices a body inside the bracket in bytes under 1 KiB and in one-decimal KiB above, and marks nothing on a hook-only note", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "small-body",
      hook: "A lesson with a short body",
      body: "x".repeat(500),
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "kib-body",
      hook: "A lesson with a longer body",
      body: "y".repeat(1228),
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "boundary-body",
      hook: "A lesson whose body is exactly one KiB",
      body: "z".repeat(1024),
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "hook-only",
      hook: "A lesson that is only its hook",
    });

    const block = await compose(PROJECT_SUBJECT);

    expect(block.text).toContain(
      "- small-body [project, just now, +500b] A lesson with a short body",
    );
    expect(block.text).toContain(
      "- kib-body [project, just now, +1.2k] A lesson with a longer body",
    );
    expect(block.text).toContain(
      "- boundary-body [project, just now, +1.0k] A lesson whose body is exactly one KiB",
    );
    expect(block.text).toContain(
      "- hook-only [project, just now] A lesson that is only its hook",
    );
    // The marker is bytes, not characters: a multi-byte body prices what it costs.
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "multibyte-body",
      hook: "A lesson with a multi-byte body",
      body: "é".repeat(300),
    });
    const withMultibyte = await compose(PROJECT_SUBJECT);
    expect(withMultibyte.text).toContain(
      "- multibyte-body [project, just now, +600b] A lesson with a multi-byte body",
    );
  });

  it("counts the marker toward the byte budget, so a block with a marker on every line stays under the cap", async () => {
    for (let index = 0; index < 30; index += 1) {
      await createNote({
        scope: "project",
        kind: "lesson",
        slug: `bodied-${String(index).padStart(3, "0")}`,
        hook: `Bodied ${index}: a representative one-line lesson hook that costs a realistic number of bytes`,
        body: "b".repeat(1500 + index),
      });
    }

    for (const bytes of [1536, 2048, 3072, 4096]) {
      const block = await compose(PROJECT_SUBJECT, { bytes, hooks: 120 });
      expect(block.bytes).toBeLessThanOrEqual(bytes);
      expect(block.entries.length).toBeGreaterThan(0);
      const entryLines = block.text
        .split("\n")
        .filter((line) => line.startsWith("- bodied-"));
      expect(entryLines).toHaveLength(block.entries.length);
      for (const line of entryLines) {
        expect(line).toMatch(
          /^- bodied-\d{3} \[project, just now, \+1\.[45]k\] /u,
        );
      }
    }
  });
});

describe("omission instruction frame (R5.2)", () => {
  it("reserves the widest instruction form so a three-digit omission at the budget floor stays under the cap", async () => {
    await seedFiller(120, "project", "proj");

    const block = await compose(PROJECT_SUBJECT, {
      bytes: MEMORY_INDEX_BUDGET_MIN_BYTES,
      hooks: 120,
    });

    expect(block.total).toBe(120);
    expect(block.omitted).toBeGreaterThan(99);
    expect(block.bytes).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET_MIN_BYTES);
    expect(block.text).toContain(
      omissionInstruction(block.entries.length, 120, block.omitted),
    );
    expect(block.text.endsWith("\n</memory-index>")).toBe(true);
  });
});

describe("delta eligibility (R5, R5.5, D4)", () => {
  it("carries a note whose watermark revision is older than its current revision, even when its updatedAt precedes lastDeliveryAt (the race shape)", async () => {
    const lesson = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "raced-lesson",
      hook: "The first wording",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());

    // Revised after the full block, then a later delivery that did not carry
    // the revision: the recorded instant passes the note's updatedAt while
    // the watermark still names revision 1.
    const revised = await updateNote(lesson, { hook: "The second wording" });
    expect(revised.revision).toBe(2);
    clock += DAY_MS;
    await telemetry.markIndexDelivery({
      conversationId: CONVERSATION_ID,
      kind: "delta",
      at: now(),
    });
    const basis = await readBasis();
    expect(basis.state.lastDeliveryAt > revised.updatedAt).toBe(true);
    expect(basis.watermarks).toEqual([
      expect.objectContaining({ memoryId: lesson.id, revision: 1 }),
    ]);

    const delta = await composeDelta(PROJECT_SUBJECT, basis);

    expect(delta.kind).toBe("delta");
    expect(delta.entries).toEqual([
      expect.objectContaining({
        memoryId: lesson.id,
        slug: "raced-lesson",
        revision: 2,
      }),
    ]);
  });

  it("carries a never-watermarked note whose updatedAt is exactly lastDeliveryAt, and a later one", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "already-held",
      hook: "A hook the full block carried",
    });
    const full = await compose(PROJECT_SUBJECT);
    const tie = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "tie-lesson",
      hook: "A hook written at the composition instant",
    });
    // The delivery is dated at the composition instant, which the tie shares.
    await settleDelivery(full, tie.updatedAt);
    const later = await createNote({
      scope: "global",
      kind: "preference",
      slug: "later-preference",
      hook: "A hook written after the delivery",
    });

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.entries.map((entry) => entry.slug)).toEqual([
      "tie-lesson",
      "later-preference",
    ]);
    expect(delta.entries.map((entry) => entry.memoryId)).toEqual([
      tie.id,
      later.id,
    ]);
  });

  it("states the instant it is a delta since, and a full block states none", async () => {
    // A preview surface has to label a delta with what it is a delta SINCE, and
    // re-deriving that by parsing the rendered text would be free to disagree
    // with the block it labels.
    const lesson = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "dated-lesson",
      hook: "A hook the full block carried",
    });
    const full = await compose(PROJECT_SUBJECT);
    if (full === null) throw new Error("expected a composed block");
    expect(full.since).toBeNull();
    const deliveredAt = now();
    await settleDelivery(full, deliveredAt);
    clock += DAY_MS;

    // A quiet turn renders one line with no `since:` in it, and still states
    // the instant structurally — which is exactly why a labelling surface
    // cannot read it off the text.
    const quiet = await composeDelta(PROJECT_SUBJECT);
    expect(quiet.since).toBe(deliveredAt);
    expect(quiet.text).not.toContain("since:");

    await updateNote(lesson, { hook: "A hook revised after the delivery" });
    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.since).toBe(deliveredAt);
    expect(delta.text).toContain(`since: ${deliveredAt}`);
  });

  it("does not carry an unchanged watermarked note", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "steady-lesson",
      hook: "A hook that has not changed",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.entries).toEqual([]);
  });

  it("does not carry a never-watermarked note older than lastDeliveryAt: the hook omitted over budget stays out (inv-delta-never-recarries)", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "carried-lesson",
      hook: "The hook the one-hook budget carried",
    });
    clock += 1000;
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "omitted-lesson",
      hook: "The hook the one-hook budget omitted",
    });
    const full = await compose(PROJECT_SUBJECT, { bytes: 4096, hooks: 1 });
    expect(full.omitted).toBe(1);
    expect(full.entries.map((entry) => entry.slug)).toEqual(["omitted-lesson"]);
    clock += 1000;
    await settleDelivery(full, now());
    clock += DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT, undefined, {
      bytes: 4096,
      hooks: 1,
    });

    expect(delta.entries).toEqual([]);
    expect(delta.text).not.toContain("carried-lesson");
  });

  it("never carries a proposed, archived, review-due, or search-only note, however new", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "baseline-lesson",
      hook: "The hook the full block carried",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += 1000;

    await createNote(
      {
        scope: "global",
        kind: "lesson",
        slug: "new-proposal",
        hook: "An agent's global proposal written after the delivery",
      },
      AGENT_IN_PROJECT,
    );
    const archived = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "new-then-archived",
      hook: "A note written and archived after the delivery",
    });
    const archive = await service.archive(
      archived.slug,
      { baseRevision: archived.revision },
      USER_IN_PROJECT,
    );
    expect(archive.ok).toBe(true);
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "new-review-due",
      hook: "A note whose review lease has already passed",
      reviewAfter: "2026-09-01T09:30:00.000Z",
    });
    await createNote({
      scope: "project",
      kind: "procedure",
      slug: "new-search-only",
      hook: "Reference material that never competes for the block",
      indexMode: "search-only",
    });
    const visible = await createNote({
      scope: "project",
      kind: "lesson",
      slug: "new-visible",
      hook: "An ordinary note written after the delivery",
    });

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.entries).toEqual([
      expect.objectContaining({ memoryId: visible.id, slug: "new-visible" }),
    ]);
    expect(delta.withheld).toEqual({ reviewDue: 1, expired: 0, proposed: 1 });
    for (const slug of [
      "new-proposal",
      "new-then-archived",
      "new-review-due",
      "new-search-only",
    ]) {
      expect(delta.text).not.toContain(slug);
    }
  });
});

describe("delta status transitions (R5, R15)", () => {
  /** A durable lesson carrying a perishable caveat on its status line (D2). */
  async function createStatusLesson(): Promise<MemoryNote> {
    return createNote({
      scope: "project",
      kind: "lesson",
      slug: "status-lesson",
      hook: "The durable lesson",
      statusNote: "never live-tested",
    });
  }

  it("carries a status-restored line with the status text and its age when the line is delivered now but the watermark says it was not", async () => {
    await createStatusLesson();
    const full = await compose(PROJECT_SUBJECT);
    expect(full.entries.map((entry) => entry.statusDelivered)).toEqual([true]);
    // The watermark records what the block carried, and this delivery
    // carried the note without its line.
    await settleDelivery(full, now(), {
      statusDelivered: { "status-lesson": false },
    });
    clock += DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.text).toContain(
      "- status-lesson: status restored: never live-tested (status as of 1 day ago)",
    );
    expect(delta.entries).toEqual([
      expect.objectContaining({
        slug: "status-lesson",
        revision: 1,
        statusDelivered: true,
      }),
    ]);
  });

  it("carries a status-withheld line naming the cause and no status text once the status lease lapses after a delivery that carried the line", async () => {
    await createStatusLesson();
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.text).toContain(
      "- status-lesson: status line withheld (review due)",
    );
    expect(delta.text).not.toContain("never live-tested");
    expect(delta.entries).toEqual([
      expect.objectContaining({
        slug: "status-lesson",
        revision: 1,
        statusDelivered: false,
      }),
    ]);
  });

  it("carries nothing for an unchanged status, whether it stays delivered or stays withheld", async () => {
    await createStatusLesson();
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += DAY_MS;
    expect((await composeDelta(PROJECT_SUBJECT)).entries).toEqual([]);

    // The lease lapses, the withheld transition is delivered and recorded,
    // and a day later there is nothing new to say about it.
    clock += MEMORY_STATUS_NOTE_LEASE_MS;
    const withheld = await composeDelta(PROJECT_SUBJECT);
    expect(withheld.entries.map((entry) => entry.statusDelivered)).toEqual([
      false,
    ]);
    await settleDelivery(withheld, now());
    clock += DAY_MS;
    expect((await composeDelta(PROJECT_SUBJECT)).entries).toEqual([]);
  });

  it("renders a revised note in the new-or-revised section only, with its current status line, never also as a transition", async () => {
    const lesson = await createStatusLesson();
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now(), {
      statusDelivered: { "status-lesson": false },
    });
    clock += DAY_MS;
    const revised = await updateNote(lesson, {
      statusNote: "live-tested on Claude only",
    });
    expect(revised.revision).toBe(2);

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.entries).toEqual([
      expect.objectContaining({
        slug: "status-lesson",
        revision: 2,
        statusDelivered: true,
      }),
    ]);
    expect(delta.text).toContain(
      "- status-lesson [project, just now] The durable lesson",
    );
    expect(delta.text).toContain(
      "  status: live-tested on Claude only (status as of just now)",
    );
    expect(delta.text).not.toContain("status restored");
  });
});

describe("delta rendering (R5, R5.5, D4)", () => {
  const DELTA_HINT =
    "read: cctl memory get <slug> --scope <scope>; search: cctl memory recall '<query>'; full index: cctl memory index --full";

  /** The index-counts line: the full block's own closing line, computed now, addressed to the index the conversation holds. */
  function indexCountsLine(shown: number, total: number): string {
    const counts = `index: showing ${shown} of ${total} hooks`;
    return total > shown
      ? `${counts} — ${total - shown} omitted over budget. If this turn touches something not in your index, search first: cctl memory recall '<topic>' (full list: cctl memory list)`
      : counts;
  }

  it("renders the since head, both sections in full-block order, the index counts, and the closing hint inside the delta tags", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "status-lesson",
      hook: "The durable lesson",
      statusNote: "never live-tested",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS;
    await createNote({
      scope: "global",
      kind: "preference",
      slug: "new-preference",
      hook: "A global preference written after the delivery",
    });
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "new-lesson",
      hook: "A project lesson written after the delivery",
      body: "The mechanism.",
    });
    const basis = await readBasis();

    const delta = await composeDelta(PROJECT_SUBJECT, basis);

    expect(delta.text).toBe(
      [
        "<memory-index-delta>",
        `since: ${basis.state.lastDeliveryAt}`,
        "## new or revised (2)",
        "- new-lesson [project, just now, +14b] A project lesson written after the delivery",
        "- new-preference [global, just now] A global preference written after the delivery",
        "## status changes (1)",
        "- status-lesson: status line withheld (review due)",
        indexCountsLine(3, 3),
        DELTA_HINT,
        "</memory-index-delta>",
      ].join("\n"),
    );
    expect(delta.bytes).toBe(memoryBodyByteLength(delta.text));
    expect(delta).toMatchObject({
      kind: "delta",
      omitted: 0,
      total: 3,
      withheld: { reviewDue: 0, expired: 0, proposed: 0 },
    });
    expect(delta.entries.map((entry) => entry.slug)).toEqual([
      "new-lesson",
      "new-preference",
      "status-lesson",
    ]);
  });

  it("states the index's current withheld and omitted counts exactly as the full block computes them now", async () => {
    await seedFiller(12, "project", "auto");
    const budget: MemoryIndexBudget = { bytes: 2048, hooks: 4 };
    const full = await compose(PROJECT_SUBJECT, budget);
    await settleDelivery(full, now());
    clock += 1000;
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "fresh-lesson",
      hook: "A note written after the delivery",
    });
    await createNote(
      {
        scope: "global",
        kind: "lesson",
        slug: "fresh-proposal",
        hook: "A proposal written after the delivery",
      },
      AGENT_IN_PROJECT,
    );

    const current = await compose(PROJECT_SUBJECT, budget);
    const delta = await composeDelta(PROJECT_SUBJECT, undefined, budget);

    expect(current.omitted).toBeGreaterThan(0);
    expect(delta.omitted).toBe(current.omitted);
    expect(delta.total).toBe(current.total);
    expect(delta.withheld).toEqual(current.withheld);
    expect(delta.text).toContain(
      indexCountsLine(current.entries.length, current.total),
    );
    expect(delta.text).toContain(
      "withheld: 1 proposed — cctl memory list --lifecycle proposed",
    );
    expect(delta.entries.map((entry) => entry.slug)).toEqual(["fresh-lesson"]);
  });

  it("caps the delta at the hook budget with the same omission instruction, apart from the index counts", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "held-lesson",
      hook: "The one hook the full block carried",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += 1000;
    await seedFiller(30, "project", "burst");
    const budget: MemoryIndexBudget = { bytes: 4096, hooks: 5 };

    const delta = await composeDelta(PROJECT_SUBJECT, undefined, budget);

    expect(delta.entries.map((entry) => entry.slug)).toEqual([
      "burst-029",
      "burst-028",
      "burst-027",
      "burst-026",
      "burst-025",
    ]);
    expect(delta.text).toContain("## new or revised (5)");
    expect(delta.text).toContain(omissionInstruction(5, 30, 25));
    expect(delta.text).toContain(indexCountsLine(5, 31));
    expect(delta.bytes).toBeLessThanOrEqual(budget.bytes);
  });

  it("caps the delta at the byte budget and states what it dropped", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "held-lesson",
      hook: "The one hook the full block carried",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += 1000;
    await seedFiller(30, "project", "burst");
    const budget: MemoryIndexBudget = {
      bytes: MEMORY_INDEX_BUDGET_MIN_BYTES,
      hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
    };

    const delta = await composeDelta(PROJECT_SUBJECT, undefined, budget);

    expect(delta.bytes).toBeLessThanOrEqual(budget.bytes);
    expect(delta.entries.length).toBeGreaterThan(0);
    expect(delta.entries.length).toBeLessThan(30);
    expect(delta.text).toContain(
      omissionInstruction(delta.entries.length, 30, 30 - delta.entries.length),
    );
    expect(delta.text).toContain(DELTA_HINT);
  });

  it("renders exactly one line naming the full-index command when nothing changed", async () => {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "steady-lesson",
      hook: "A hook that has not changed",
    });
    const full = await compose(PROJECT_SUBJECT);
    await settleDelivery(full, now());
    clock += DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT);

    expect(delta.text).toBe(
      "<memory-index-delta>no memory changes since your last turn — full index: cctl memory index --full</memory-index-delta>",
    );
    expect(delta).toMatchObject({
      kind: "delta",
      entries: [],
      omitted: 0,
      total: 1,
      bytes: memoryBodyByteLength(delta.text),
    });
  });

  it("keeps the quiet form to one line even when the index has omitted and withheld records", async () => {
    await seedFiller(12, "project", "auto");
    await createNote(
      {
        scope: "global",
        kind: "lesson",
        slug: "pending-proposal",
        hook: "A proposal awaiting approval",
      },
      AGENT_IN_PROJECT,
    );
    const budget: MemoryIndexBudget = { bytes: 2048, hooks: 4 };
    const full = await compose(PROJECT_SUBJECT, budget);
    expect(full.omitted).toBeGreaterThan(0);
    await settleDelivery(full, now());
    clock += DAY_MS;

    const delta = await composeDelta(PROJECT_SUBJECT, undefined, budget);

    expect(delta.text.split("\n")).toHaveLength(1);
    expect(delta.text).toContain("cctl memory index --full");
    expect(delta).toMatchObject({
      entries: [],
      omitted: full.omitted,
      total: full.total,
      withheld: { reviewDue: 0, expired: 0, proposed: 1 },
    });
  });
});
