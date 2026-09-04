import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { PublishFn } from "@/lib/events/publication";
import type { Logger } from "@/lib/logging";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createMemoryFreshnessEngine } from "./freshness";
import {
  createMemoryRecallService,
  type MemoryContextPack,
  type MemoryRecallService,
} from "./recall";
import {
  memoryQueryLiterals,
  type MemoryRankedProvider,
} from "./recall-providers";
import {
  MEMORY_RECALL_FULL_BODY_MAX,
  MEMORY_RECALL_MAX_QUERY_CHARS,
  MEMORY_RECALL_MIN_BUDGET_CHARS,
  MEMORY_STATUS_NOTE_LEASE_MS,
  type CreateMemoryNoteRequest,
  type LinkMemoryNoteRequest,
  type MemoryActor,
  type MemoryNote,
} from "./schemas";
import { createMemoryService, type MemoryService } from "./service";
import { openMemoryContributionGate } from "./testing/contribution-gate";
import {
  loadMemoryEvalCorpus,
  memoryEvalQueryTerms,
  seedMemoryEvalCorpus,
} from "./testing/eval-corpus";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
/** The ticket the corpus's status specimen is about-linked to. */
const LINKED_TICKET = "ticket-88";
const BASE_TIME = Date.UTC(2026, 8, 1, 10, 0, 0);

const USER_IN_PROJECT: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: null },
};

let db: Db;
let repo: MemoryRepo;
let service: MemoryService;
let recall: MemoryRecallService;
let clock: number;
let idSeq: number;

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

/** Recall's log lines, captured through the injected logger this suite passes. */
let recallLogs: CapturedLog[];

function captureLogger(): Logger {
  const make =
    (level: CapturedLog["level"]) =>
    (event: string, fields?: Record<string, unknown>) => {
      recallLogs.push({ level, event, fields: fields ?? {} });
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
}

const publish: PublishFn = () => ({ delivered: true });

function now(): string {
  return new Date(BASE_TIME + clock).toISOString();
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
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
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
  });
  recallLogs = [];
  recall = createMemoryRecallService({
    repo,
    freshness: createMemoryFreshnessEngine({ repo, sessions, now }),
    now,
    logger: captureLogger(),
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

async function recallPack(
  request: Parameters<MemoryRecallService["recall"]>[0],
  actor: MemoryActor = USER_IN_PROJECT,
): Promise<MemoryContextPack> {
  const result = await recall.recall(request, actor);
  if (!result.ok) {
    throw new Error(`recall refused: ${result.error.code}`);
  }
  return result.value;
}

/** A refused recall, narrowed to the one refusal shape recall can produce. */
async function recallRefusal(
  request: Parameters<MemoryRecallService["recall"]>[0],
): Promise<{ instruction: string; issues: string }> {
  const result = await recall.recall(request, USER_IN_PROJECT);
  if (result.ok) {
    throw new Error("expected the recall request to be refused");
  }
  if (result.error.code !== "validation_failed") {
    throw new Error(`unexpected refusal code: ${result.error.code}`);
  }
  return {
    instruction: result.error.instruction,
    issues: result.error.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join(" | "),
  };
}

function slugsOf(pack: MemoryContextPack): string[] {
  return pack.entries.map((entry) => entry.note.slug);
}

describe("recall over the committed evaluation corpus (R7.1)", () => {
  const corpus = loadMemoryEvalCorpus();

  it("declares only about and source links, seeded through the link verb (R8)", async () => {
    // The corpus is the delivery's evidence base, so its own shape is pinned:
    // a fixture that reintroduced a watch would otherwise seed retrieval
    // semantics the spec removed, and every ranking assertion below would be
    // measuring a corpus the product can no longer produce.
    const declared = corpus.notes.flatMap((note) =>
      note.link === undefined ? [] : [note.link.kind],
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.every((kind) => kind === "about" || kind === "source"),
    ).toBe(true);

    const seeded = await seedCorpus();
    const specimen = seeded.get("ticket88-cursor-darwin-status");
    expect(specimen).toBeDefined();
    if (specimen === undefined) return;
    const links = await repo.listLinks(specimen.id);
    expect(links.map((row) => row.kind)).toEqual(["about"]);
    // The withheld statusNote survives the watch removal: it is leased, not
    // bound to any artifact transition.
    expect(specimen.statusNote?.text).toBe("ticket-88 work still unmerged");
    expect(specimen.statusNote?.reviewAfter).not.toBeNull();
  });

  it("declares the spec's ten queries including exactly one body-only case", () => {
    expect(corpus.queries).toHaveLength(10);
    expect(
      corpus.queries.filter((query) => query.requireBodyOnly),
    ).toHaveLength(1);
    expect(corpus.queries.some((query) => query.query === "notebook")).toBe(
      true,
    );
  });

  it.each(
    corpus.queries.map(
      (query) => [`${query.query} (${query.via})`, query] as const,
    ),
  )("%s resolves in one call", async (_label, expected) => {
    await seedCorpus();

    const pack = await recallPack({ query: expected.query });

    expect(slugsOf(pack)).toContain(expected.expectSlug);
    const entry = pack.entries.find(
      (candidate) => candidate.note.slug === expected.expectSlug,
    );
    expect(entry?.tier).toBe("full");

    if (expected.requireBodyOnly) {
      // The spec's body-only symptom case. Without this guard the assertion
      // above would still pass if every query term also sat in the slug or
      // hook, proving nothing about whether the body is indexed at all.
      const note = entry?.note;
      const outsideBody = [
        note?.slug ?? "",
        note?.hook ?? "",
        ...(note?.aliases ?? []),
      ]
        .join(" ")
        .toLowerCase();
      const terms = memoryEvalQueryTerms(expected.query);
      expect(terms.length).toBeGreaterThan(0);
      expect(terms.filter((term) => outsideBody.includes(term))).toEqual([]);
    }
  });
});

async function capture(
  overrides: Partial<CreateMemoryNoteRequest> & { slug: string; hook: string },
  actor: MemoryActor = USER_IN_PROJECT,
): Promise<MemoryNote> {
  const created = await service.create(
    { scope: "project", kind: "lesson", body: "", ...overrides },
    actor,
  );
  if (!created.ok) {
    throw new Error(`capture refused: ${created.error.code}`);
  }
  return created.value.note;
}

async function link(
  slug: string,
  request: LinkMemoryNoteRequest,
): Promise<void> {
  const linked = await service.link(slug, request, USER_IN_PROJECT);
  if (!linked.ok) {
    throw new Error(`link refused: ${linked.error.code}`);
  }
}

describe("retrieval modes (R7)", () => {
  it("ambient recall carries the visible union and leaves out records that opted out of it", async () => {
    await capture({ slug: "ambient-lesson", hook: "Delivered ambiently" });
    await capture({
      slug: "search-only-lesson",
      hook: "Findable by search alone",
      indexMode: "search-only",
    });
    await service.create(
      { scope: "global", kind: "lesson", hook: "Awaiting a human decision" },
      {
        kind: "agent",
        conversationId: "conv-1",
        visibility: { projectPath: PROJECT_PATH, session: null },
      },
    );

    const ambient = await recallPack({});
    const searched = await recallPack({ query: "findable search" });

    expect(ambient.mode).toBe("ambient");
    expect(slugsOf(ambient)).toEqual(["ambient-lesson"]);
    expect(slugsOf(searched)).toContain("search-only-lesson");
  });

  it("ambient recall ranks a record about-linked to an active artifact above the rest", async () => {
    await capture({ slug: "aaa-unlinked", hook: "Alphabetically first" });
    await capture({ slug: "zzz-linked", hook: "Alphabetically last" });
    await link("zzz-linked", {
      kind: "about",
      artifact: { kind: "ticket", ticketId: LINKED_TICKET },
    });

    const pack = await recallPack({
      activeArtifacts: [{ kind: "ticket", ticketId: LINKED_TICKET }],
    });

    expect(slugsOf(pack)).toEqual(["zzz-linked", "aaa-unlinked"]);
  });

  it("related recall resolves the artifact's about links and nothing else", async () => {
    const artifact = { kind: "ticket", ticketId: LINKED_TICKET } as const;
    await capture({ slug: "about-linked", hook: "Linked as about" });
    await capture({ slug: "source-linked", hook: "Linked as source" });
    await link("about-linked", { kind: "about", artifact });
    await link("source-linked", { kind: "source", artifact });

    const pack = await recallPack({ related: artifact });

    expect(pack.mode).toBe("related");
    expect(slugsOf(pack)).toEqual(["about-linked"]);
  });
});

describe("exact-match boosts (R7)", () => {
  const cases = [
    {
      name: "an alias match outranks denser prose",
      query: "notebook",
      expected: "notepad-roadmap",
      notes: [
        {
          slug: "notepad-roadmap",
          hook: "The feature is named Notepad",
          aliases: ["notebook"],
          body: "Slice 3 covers clips and voice capture.",
        },
        {
          slug: "prose-mentions",
          hook: "A notebook metaphor",
          body: "notebook notebook notebook",
        },
      ],
    },
    {
      name: "a cased symbol outranks the same letters in lowercase prose",
      query: "ENAMETOOLONG",
      expected: "migration-name-length",
      notes: [
        {
          slug: "migration-name-length",
          hook: "Long worktree names fail the migration test",
          body: "The base64-encoded path fails with ENAMETOOLONG.",
        },
        {
          slug: "prose-mentions",
          hook: "A prose note about enametoolong",
          body: "enametoolong enametoolong enametoolong",
        },
      ],
    },
    {
      name: "a file path outranks a note that only shares its words",
      query: "src/lib/memory/recall.ts",
      expected: "recall-module",
      notes: [
        {
          slug: "recall-module",
          hook: "The recall pipeline",
          body: "It lives at src/lib/memory/recall.ts and owns ranking.",
        },
        {
          slug: "prose-mentions",
          hook: "Memory recall lives under src lib",
          body: "recall memory lib src recall memory lib src",
        },
      ],
    },
    {
      name: "a native artifact handle outranks its spelled-out words",
      query: "command-center#74",
      expected: "spike-ticket",
      notes: [
        {
          slug: "spike-ticket",
          hook: "The memory spike",
          body: "Tracked as command-center#74 from start to finish.",
        },
        {
          slug: "prose-mentions",
          hook: "The command center numbering",
          body: "command center 74 command center 74",
        },
      ],
    },
  ] as const;

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, testCase) => {
      for (const note of testCase.notes) {
        await capture({
          slug: note.slug,
          hook: note.hook,
          body: note.body,
          ...("aliases" in note ? { aliases: [...note.aliases] } : {}),
        });
      }

      const pack = await recallPack({ query: testCase.query });

      expect(slugsOf(pack)[0]).toBe(testCase.expected);
    },
  );

  it("classifies only distinguishing shapes as literals", () => {
    expect(
      memoryQueryLiterals(
        "the onTaskUpdate timeout in src/lib/memory/recall.ts for command-center#74 and MAX_RETRIES",
      ),
    ).toEqual([
      "onTaskUpdate",
      "src/lib/memory/recall.ts",
      "command-center#74",
      "MAX_RETRIES",
    ]);
  });
});

describe("the ranked-provider seam (D5)", () => {
  it("composes a registered provider's candidates without touching the pack contract", async () => {
    const note = await capture({
      slug: "semantic-only",
      hook: "No lexical overlap at all",
    });
    const semantic: MemoryRankedProvider = {
      id: "test-semantic",
      async rank() {
        return [{ note, relevance: 5 }];
      },
    };
    const composed = createMemoryRecallService({
      repo,
      freshness: createMemoryFreshnessEngine({
        repo,
        sessions: {
          async isSessionIncarnationOver() {
            return false;
          },
        },
        now,
      }),
      providers: [semantic],
      now,
    });

    const result = await composed.recall(
      { query: "entirely unrelated words" },
      USER_IN_PROJECT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(slugsOf(result.value)).toEqual(["semantic-only"]);
  });
});

describe("the bounded context pack (R7.2)", () => {
  /** Distinct per note: a shared body cannot prove a hook withheld its own. */
  function longBody(marker: string): string {
    return `Recorded detail ${marker}. `.repeat(12);
  }

  async function captureMany(
    count: number,
    body: (marker: string) => string,
    scope: CreateMemoryNoteRequest["scope"] = "project",
  ): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      const slug = `${scope}-lesson-${index}`;
      await capture({
        scope,
        slug,
        hook: `Recorded lesson ${index}`,
        body: body(slug),
      });
    }
  }

  function tiersOf(pack: MemoryContextPack): string[] {
    return pack.entries.map((entry) => entry.tier);
  }

  it("spends its budget on the best few full bodies, then hooks with exact read commands", async () => {
    await captureMany(8, longBody);

    const pack = await recallPack({ budgetChars: 1600 });

    expect(pack.text.length).toBeLessThanOrEqual(1600);
    expect(pack.total).toBe(8);
    expect(pack.showing).toBeLessThan(pack.total);
    const tiers = tiersOf(pack);
    expect(tiers).toContain("full");
    expect(tiers).toContain("hook");
    for (const entry of pack.entries) {
      expect(entry.readCommand).toBe(
        `cctl memory get ${entry.note.slug} --scope ${entry.note.scope}`,
      );
      if (entry.tier === "hook") {
        expect(pack.text).toContain(`read: ${entry.readCommand}`);
        expect(pack.text).not.toContain(entry.note.body);
      } else {
        expect(pack.text).toContain(entry.note.body);
      }
    }
  });

  it("never gives a lower-ranked record the body the budget denied the one above it", async () => {
    await capture({
      slug: "aaa-long",
      hook: "The best match, at length",
      body: longBody("aaa").repeat(6),
    });
    await capture({ slug: "bbb-short", hook: "A lesser match", body: "brief" });

    const pack = await recallPack({ budgetChars: 900 });

    // `bbb-short` would fit as a full body, but taking one would hand a
    // lower-ranked record more of the pack than the record above it got.
    expect(slugsOf(pack)).toEqual(["aaa-long", "bbb-short"]);
    expect(tiersOf(pack)).toEqual(["hook", "hook"]);
  });

  it("caps the full-body tier at the best few however small the bodies are", async () => {
    await captureMany(8, () => "short");

    const pack = await recallPack({});

    expect(tiersOf(pack)).toEqual([
      ...Array.from({ length: MEMORY_RECALL_FULL_BODY_MAX }, () => "full"),
      "hook",
      "hook",
      "hook",
    ]);
    expect(pack.showing).toBe(8);
    expect(pack.total).toBe(8);
    expect(pack.narrowCommand).toBeNull();
    expect(pack.text.endsWith("Showing 8 of 8 memory records.")).toBe(true);
  });

  it("closes an omitting pack with showing-N-of-M and a scope narrowing that actually narrows", async () => {
    await captureMany(2, () => "brief");
    await captureMany(6, longBody, "global");

    const pack = await recallPack({ budgetChars: 1600 });

    // Project outranks global, so the omitted tail is global only: re-running
    // in that scope drops the project records and frees the budget for it.
    expect(pack.narrowCommand).toBe("cctl memory recall --scope global");
    expect(pack.text).toContain(
      `Showing ${pack.showing} of ${pack.total} memory records — narrow with: cctl memory recall --scope global`,
    );
  });

  it("carries the query into the narrowing command", async () => {
    await captureMany(2, () => "brief");
    await captureMany(6, longBody, "global");

    const pack = await recallPack({
      query: "recorded lesson",
      budgetChars: 1600,
    });

    expect(pack.narrowCommand).toBe(
      "cctl memory recall 'recorded lesson' --scope global",
    );
  });

  it.each([MEMORY_RECALL_MIN_BUDGET_CHARS, 800, 1200, 2400, 6000])(
    "stays inside a %i-character budget over the real corpus and still discloses the remainder",
    async (budgetChars) => {
      await seedCorpus();

      const pack = await recallPack({ budgetChars });

      expect(pack.text.length).toBeLessThanOrEqual(budgetChars);
      // Never a silent truncation: the counts are stated at every budget.
      expect(pack.text).toContain(
        `Showing ${pack.showing} of ${pack.total} memory records`,
      );
      expect(pack.showing).toBeLessThanOrEqual(pack.total);
      if (pack.showing < pack.total) {
        expect(pack.narrowCommand).not.toBeNull();
      }
      // inv-slug-only-text-output: slugs are the handle, ids stay in --json.
      for (const entry of pack.entries) {
        expect(pack.text).not.toContain(entry.note.id);
      }
    },
  );

  it("names the next omitted record when no scope narrowing would shrink the set", async () => {
    await captureMany(8, longBody);

    const pack = await recallPack({ budgetChars: 1600 });

    // Every candidate is project-scoped, so `--scope project` would return
    // exactly the same set: the honest exact command is the next record's read.
    const nextOmitted = `project-lesson-${pack.showing + 1}`;
    expect(pack.narrowCommand).toBe(
      `cctl memory get ${nextOmitted} --scope project`,
    );
  });
});

describe("freshness gates the pack rather than scoring it (R7)", () => {
  const PAST = new Date(BASE_TIME - 1000).toISOString();

  it("keeps a review-due note out of ambient delivery and out of the full-body tier", async () => {
    // The stale record is the BETTER lexical match, so it stays ranked first
    // and the gate is the only thing that can deny it a body.
    await capture({
      slug: "aaa-review-due",
      hook: "A distinctive lesson",
      body: "distinctive lesson ".repeat(8),
      reviewAfter: PAST,
    });
    await capture({
      slug: "bbb-fresh",
      hook: "A distinctive lesson",
      body: "unrelated prose about something else entirely",
    });

    const ambient = await recallPack({});
    const searched = await recallPack({ query: "distinctive lesson" });

    expect(slugsOf(ambient)).toEqual(["bbb-fresh"]);
    // The gate denies the stale record a full body without demoting the fresh
    // record ranked below it: only the budget makes the full tier a prefix.
    expect(slugsOf(searched)).toEqual(["aaa-review-due", "bbb-fresh"]);
    expect(searched.entries.map((entry) => entry.tier)).toEqual([
      "hook",
      "full",
    ]);
  });

  it("delivers a note whose only staleness is its statusNote without the stale line", async () => {
    await seedCorpus();
    const slug = "ticket88-cursor-darwin-status";

    const fresh = await recallPack({ query: slug });
    // Nothing observes the ticket: the status lease simply runs out (R2, R8).
    clock += MEMORY_STATUS_NOTE_LEASE_MS + 24 * 60 * 60 * 1000;
    const drifted = await recallPack({ query: slug });

    const before = fresh.entries.find((entry) => entry.note.slug === slug);
    const after = drifted.entries.find((entry) => entry.note.slug === slug);
    expect(before?.statusLine).toContain("status as of");
    expect(after?.tier).toBe("full");
    expect(after?.statusLine).toBeNull();
    expect(drifted.text).toContain(after?.note.body ?? "MISSING");
    expect(drifted.text).not.toContain("status as of");
  });
});

describe("retrieval frequency never affects ranking (inv-no-popularity-or-telemetry-rank)", () => {
  it("ranks a heavily retrieved record exactly where its never-retrieved equal sits", async () => {
    const shared = {
      hook: "An equally weighted lesson",
      body: "equal signals",
    };
    await capture({ slug: "equal-alpha", ...shared });
    await capture({ slug: "equal-beta", ...shared });

    const baselineAmbient = await recallPack({});
    const baselineQuery = await recallPack({ query: "equally weighted" });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await recallPack({ query: "equal-beta" });
      const read = await service.get("equal-beta", USER_IN_PROJECT);
      expect(read.ok).toBe(true);
    }

    expect(slugsOf(await recallPack({}))).toEqual(slugsOf(baselineAmbient));
    expect(slugsOf(await recallPack({ query: "equally weighted" }))).toEqual(
      slugsOf(baselineQuery),
    );
    expect(slugsOf(baselineQuery)).toEqual(["equal-alpha", "equal-beta"]);
  });
});

describe("about links are the only relevance cue (inv-about-links-only-cues)", () => {
  it("ranks about-linked records above unlinked lexical matches and grants source nothing", async () => {
    const artifact = { kind: "ticket", ticketId: LINKED_TICKET } as const;
    const dense = {
      hook: "A cascade lesson",
      body: "cascade lesson ".repeat(8),
    };
    await capture({ slug: "aaa-source-linked", ...dense });
    await capture({ slug: "ccc-unlinked", ...dense });
    // The weakest lexical match of the four: only the about link can lift it.
    await capture({
      slug: "zzz-about-linked",
      hook: "A cascade lesson",
      body: "otherwise unrelated prose",
    });
    await link("aaa-source-linked", { kind: "source", artifact });
    await link("zzz-about-linked", { kind: "about", artifact });

    const query = "cascade lesson";
    const lexicalOnly = await recallPack({ query });
    const pack = await recallPack({ related: artifact, query });

    expect(slugsOf(lexicalOnly).at(-1)).toBe("zzz-about-linked");
    expect(slugsOf(pack)[0]).toBe("zzz-about-linked");
    // A source link to the very same artifact moves nothing: every other
    // record keeps the exact position its lexical score alone earned.
    const withoutAbout = (slugs: string[]): string[] =>
      slugs.filter((slug) => slug !== "zzz-about-linked");
    expect(withoutAbout(slugsOf(pack))).toEqual(
      withoutAbout(slugsOf(lexicalOnly)),
    );
  });
});

describe("the search index is derived state (inv-fts-derived-rebuildable)", () => {
  it("returns identical packs for every corpus query after a full index rebuild", async () => {
    await seedCorpus();
    const corpus = loadMemoryEvalCorpus();
    const before = new Map<string, string>();
    for (const { query } of corpus.queries) {
      before.set(query, (await recallPack({ query })).text);
    }

    const indexed = await repo.rebuildSearchIndex();

    expect(indexed).toBe(corpus.notes.length);
    for (const { query } of corpus.queries) {
      expect((await recallPack({ query })).text).toBe(before.get(query));
    }
  });
});

describe("the pack never truncates a match silently (R7.2)", () => {
  it("counts every visible match in showing-N-of-M however many there are", async () => {
    const matches = 60;
    for (let index = 1; index <= matches; index += 1) {
      await capture({
        slug: `haystack-${String(index).padStart(3, "0")}`,
        hook: `Haystack record ${index}`,
        body: "a shared haystack term",
      });
    }

    const pack = await recallPack({ query: "haystack", budgetChars: 1200 });

    // A provider that sliced its results to a fixed candidate limit would
    // report an M of at most that limit, hiding the remainder behind a count
    // that looks complete.
    expect(pack.total).toBe(matches);
    expect(pack.showing).toBeLessThan(pack.total);
    expect(pack.text).toContain(`of ${matches} memory records`);
    expect(pack.narrowCommand).not.toBeNull();
  });
});

describe("rendered read commands resolve the record they name", () => {
  it("qualifies a slug shared across scopes so the command is unambiguous", async () => {
    const shared = { slug: "shared-slug", hook: "A lesson recorded twice" };
    await capture({ ...shared, scope: "project", body: "the project answer" });
    await capture({ ...shared, scope: "global", body: "the global answer" });

    const pack = await recallPack({});

    expect(slugsOf(pack)).toEqual(["shared-slug", "shared-slug"]);
    // The bare handle is genuinely ambiguous for this caller...
    const bare = await service.get("shared-slug", USER_IN_PROJECT);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe("ambiguous_handle");
    // ...so every rendered command must carry the scope that disambiguates it.
    for (const entry of pack.entries) {
      expect(entry.readCommand).toBe(
        `cctl memory get shared-slug --scope ${entry.note.scope}`,
      );
      const resolved = await service.get("shared-slug", USER_IN_PROJECT, {
        scope: entry.note.scope,
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.value.note.id).toBe(entry.note.id);
    }
  });
});

describe("a stated budget is always honoured (R7.2)", () => {
  it("refuses a budget below the floor and names the limit", async () => {
    await capture({ slug: "any-lesson", hook: "Anything at all" });

    const refusal = await recallRefusal({ budgetChars: 1 });

    expect(refusal.issues).toContain("budgetChars");
    expect(refusal.issues).toContain(String(MEMORY_RECALL_MIN_BUDGET_CHARS));
  });

  it("refuses a query longer than the frame could ever reproduce", async () => {
    const refusal = await recallRefusal({
      query: "x".repeat(MEMORY_RECALL_MAX_QUERY_CHARS + 1),
    });

    expect(refusal.issues).toContain("query");
    expect(refusal.issues).toContain(String(MEMORY_RECALL_MAX_QUERY_CHARS));
  });

  it("refuses rather than overrun when the frame itself cannot fit", async () => {
    await capture({ slug: "any-lesson", hook: "Anything at all" });

    // Accepted by the schema, but a maximal query has to be reproduced
    // verbatim in the narrowing command, which alone outgrows this budget.
    const refusal = await recallRefusal({
      query: "haystack "
        .repeat(20)
        .trim()
        .slice(0, MEMORY_RECALL_MAX_QUERY_CHARS),
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS,
      related: {
        kind: "session",
        projectPath: PROJECT_PATH,
        sessionName: `a-very-long-session-name-${"x".repeat(400)}`,
        sessionCreatedAt: new Date(BASE_TIME).toISOString(),
      },
    });

    expect(refusal.instruction).toMatch(/budgetChars of at least \d+/u);
  });

  it("keeps the accepted maximum query inside the default budget", async () => {
    await seedCorpus();

    const pack = await recallPack({
      query: "swap".padEnd(MEMORY_RECALL_MAX_QUERY_CHARS, " y"),
    });

    expect(pack.text.length).toBeLessThanOrEqual(6000);
    expect(pack.text).toContain("memory records");
  });
});

describe("ranked providers fuse by rank, not by raw score", () => {
  it("does not let one provider's score scale dominate another's", async () => {
    const wide = await capture({
      slug: "wide-scale",
      hook: "Scored in thousands",
    });
    const narrow = await capture({
      slug: "narrow-scale",
      hook: "Scored in decimals",
    });
    const freshness = createMemoryFreshnessEngine({
      repo,
      sessions: {
        async isSessionIncarnationOver() {
          return false;
        },
      },
      now,
    });
    const bigScale: MemoryRankedProvider = {
      id: "big-scale",
      async rank() {
        return [{ note: wide, relevance: 9_000_000 }];
      },
    };
    const smallScale: MemoryRankedProvider = {
      id: "small-scale",
      async rank() {
        return [
          { note: narrow, relevance: 0.9 },
          { note: wide, relevance: 0.1 },
        ];
      },
    };
    const composed = createMemoryRecallService({
      repo,
      freshness,
      providers: [bigScale, smallScale],
      now,
    });

    const result = await composed.recall({ query: "scale" }, USER_IN_PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both providers rank `wide-scale` (1st and 2nd) against one 1st place for
    // `narrow-scale`, so agreement wins — and the nine-million-point scale
    // buys nothing it would not have bought at 0.9.
    expect(slugsOf(result.value)).toEqual(["wide-scale", "narrow-scale"]);
  });
});

describe("recall's structured log line (R15, R15.2)", () => {
  /** Every field recall's own event may carry, per the no-content invariant. */
  function infoEvents(): CapturedLog[] {
    return recallLogs.filter((entry) => entry.level === "info");
  }

  it("emits one content-free event per call, naming query, mode, hits, and pack size", async () => {
    await seedCorpus();
    recallLogs = [];

    const hit = await recallPack({
      query: "turbopack",
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS * 4,
    });
    expect(infoEvents()).toHaveLength(1);
    expect(infoEvents()[0]).toMatchObject({
      event: "memory.recall.query",
      fields: {
        query: "turbopack",
        mode: "query",
        hits: hit.total,
        chars: hit.text.length,
      },
    });
    expect(hit.total).toBeGreaterThan(0);

    recallLogs = [];
    const ambient = await recallPack({
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS * 4,
    });
    // Ambient recall has no query, and the field says so rather than going
    // missing: a reader counting misses must see every call.
    expect(infoEvents()[0]?.fields).toMatchObject({
      query: null,
      mode: "ambient",
      hits: ambient.total,
      chars: ambient.text.length,
    });

    recallLogs = [];
    const miss = await recallPack({
      query: "helium refractive index",
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS * 4,
    });
    expect(miss.total).toBe(0);
    // A zero-hit query is identifiable from the log alone (R15.2).
    expect(infoEvents()).toHaveLength(1);
    expect(infoEvents()[0]?.fields).toMatchObject({
      query: "helium refractive index",
      mode: "query",
      hits: 0,
    });
  });

  it("puts no hook, body, or status text of a delivered note in the event", async () => {
    const seeded = await seedCorpus();
    recallLogs = [];

    // The widest pack this corpus produces: if any delivered content could
    // reach the log line, the mode that carries the most is where it shows.
    const pack = await recallPack({
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS * 20,
    });
    expect(pack.showing).toBeGreaterThan(0);
    await recallPack({
      query: "turbopack cache slow build",
      budgetChars: MEMORY_RECALL_MIN_BUDGET_CHARS * 20,
    });

    const emitted = JSON.stringify(recallLogs);
    for (const note of seeded.values()) {
      expect(emitted).not.toContain(note.hook);
      if (note.body !== "") expect(emitted).not.toContain(note.body);
      if (note.statusNote !== null) {
        expect(emitted).not.toContain(note.statusNote.text);
      }
    }
  });
});
