import { describe, expect, it } from "vitest";

import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  MEMORY_INDEX_BUDGET_MIN_BYTES,
  MEMORY_MAX_ALIASES,
  memoryIndexBudgetSchema,
  memoryActorSchema,
  memoryChangeKindSchema,
  memoryChangedEventSchema,
  memoryLinkSchema,
  linkMemoryNoteRequestSchema,
  memoryNoteRevisionSchema,
  memoryNoteSchema,
  type MemoryNote,
  memoryLifecycleActRequestSchema,
  memoryProposalDecisionRequestSchema,
  MEMORY_STATE_NOTE_LEASE_MS,
  MEMORY_STATUS_NOTE_LEASE_MS,
  markMemoryReviewedRequestSchema,
  memoryReviewQueueEntrySchema,
  memoryStalenessSchema,
} from "./schemas";

const SESSION_INCARNATION = {
  projectPath: "/Users/alex/github/command-center",
  sessionName: "memory-spike",
  sessionCreatedAt: "2026-09-01T09:00:00.000Z",
};

function globalNote(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "mem-1",
    slug: "fts-is-derived",
    scope: "global",
    projectPath: null,
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "The FTS5 table is derived state and can be rebuilt from the note rows",
    body: "A rebuild drops and repopulates the index from `memory_notes`.",
    statusNote: null,
    aliases: [],
    indexMode: "auto",
    lifecycle: "active",
    reviewAfter: null,
    expiresAt: null,
    supersedesId: null,
    supersededById: null,
    createdBy: "user",
    authorConversationId: null,
    revision: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function projectNote(overrides: Record<string, unknown> = {}): unknown {
  return globalNote({
    scope: "project",
    projectPath: SESSION_INCARNATION.projectPath,
    ...overrides,
  });
}

function sessionNote(overrides: Record<string, unknown> = {}): unknown {
  return globalNote({
    scope: "session",
    ...SESSION_INCARNATION,
    ...overrides,
  });
}

function refusalMessages(value: unknown): string[] {
  const result = memoryNoteSchema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe("memoryNoteSchema", () => {
  it("round-trips a maximal note through parse", () => {
    const maximal = projectNote({
      slug: "ticket88-cursor-darwin-status",
      kind: "lesson",
      aliases: ["cursor-darwin", "evidenced-hosts"],
      statusNote: {
        text: "ticket-88 work still unmerged",
        updatedAt: "2026-08-30T12:00:00.000Z",
        reviewAfter: "2026-09-13T12:00:00.000Z",
      },
      indexMode: "always",
      lifecycle: "proposed",
      reviewAfter: "2026-09-20T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      supersedesId: "mem-0",
      supersededById: "mem-2",
      createdBy: "agent",
      authorConversationId: "conversation-7",
      revision: 4,
    });

    const parsed: MemoryNote = memoryNoteSchema.parse(maximal);

    expect(parsed).toEqual(maximal);
  });

  it("parses a session-scoped state note", () => {
    expect(() =>
      memoryNoteSchema.parse(sessionNote({ kind: "state" })),
    ).not.toThrow();
  });

  it("refuses a body over the 8 KiB cap and names the limit", () => {
    const messages = refusalMessages(
      globalNote({ body: "x".repeat(MEMORY_BODY_MAX_BYTES + 1) }),
    );

    expect(messages.join(" ")).toContain(String(MEMORY_BODY_MAX_BYTES));
  });

  it("caps the body in bytes, not characters", () => {
    // Four bytes per emoji: a body under the cap by character count is over it
    // by byte count, which is the cap the spec states.
    const overByBytes = "😀".repeat(MEMORY_BODY_MAX_BYTES / 4 + 1);
    expect(overByBytes.length).toBeLessThan(MEMORY_BODY_MAX_BYTES);

    expect(
      memoryNoteSchema.safeParse(globalNote({ body: overByBytes })).success,
    ).toBe(false);
    expect(
      memoryNoteSchema.safeParse(
        globalNote({ body: "😀".repeat(MEMORY_BODY_MAX_BYTES / 4) }),
      ).success,
    ).toBe(true);
  });

  it("refuses the state kind outside session scope", () => {
    expect(refusalMessages(globalNote({ kind: "state" })).join(" ")).toContain(
      "session",
    );
    expect(refusalMessages(projectNote({ kind: "state" })).join(" ")).toContain(
      "session",
    );
  });

  it("refuses a statusNote on a state note", () => {
    const messages = refusalMessages(
      sessionNote({
        kind: "state",
        statusNote: {
          text: "still running",
          updatedAt: "2026-09-01T10:00:00.000Z",
          reviewAfter: "2026-09-15T10:00:00.000Z",
        },
      }),
    );

    expect(messages.join(" ")).toContain("statusNote");
  });

  it("refuses a scope that disagrees with its owner", () => {
    expect(
      memoryNoteSchema.safeParse(globalNote({ projectPath: "/repo" })).success,
    ).toBe(false);
    expect(
      memoryNoteSchema.safeParse(projectNote({ projectPath: null })).success,
    ).toBe(false);
    expect(
      memoryNoteSchema.safeParse(
        sessionNote({ sessionName: null, sessionCreatedAt: null }),
      ).success,
    ).toBe(false);
    expect(
      memoryNoteSchema.safeParse(
        projectNote({
          sessionName: "memory-spike",
          sessionCreatedAt: "2026-09-01T09:00:00.000Z",
        }),
      ).success,
    ).toBe(false);
    expect(
      memoryNoteSchema.safeParse(sessionNote({ sessionCreatedAt: null }))
        .success,
    ).toBe(false);
  });

  it("refuses a multi-line statusNote", () => {
    expect(
      memoryNoteSchema.safeParse(
        projectNote({
          statusNote: {
            text: "line one\nline two",
            updatedAt: "2026-08-30T12:00:00.000Z",
            reviewAfter: "2026-09-13T12:00:00.000Z",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses a multi-line hook", () => {
    expect(
      memoryNoteSchema.safeParse(
        globalNote({ hook: "first line\nsecond line" }),
      ).success,
    ).toBe(false);
  });

  it("bounds the alias list", () => {
    expect(
      memoryNoteSchema.safeParse(
        globalNote({
          aliases: Array.from(
            { length: MEMORY_MAX_ALIASES + 1 },
            (_unused, index) => `alias-${index}`,
          ),
        }),
      ).success,
    ).toBe(false);
  });
});

describe("memoryLinkSchema", () => {
  const aboutTicket = {
    id: "link-1",
    memoryId: "mem-1",
    kind: "about",
    artifact: { kind: "ticket", ticketId: "ticket-74" },
    createdAt: "2026-09-01T10:00:00.000Z",
  };

  it("parses an about link to a ticket", () => {
    expect(memoryLinkSchema.parse(aboutTicket)).toEqual(aboutTicket);
  });

  it("refuses a link naming the removed watch kind (R8, D6)", () => {
    const rowIssues = memoryLinkSchema.safeParse({
      ...aboutTicket,
      kind: "watch",
    });
    expect(rowIssues.success).toBe(false);
    expect(JSON.stringify(rowIssues.error?.issues)).toContain("Invalid option");

    const writeIssues = linkMemoryNoteRequestSchema.safeParse({
      kind: "watch",
      artifact: aboutTicket.artifact,
    });
    expect(writeIssues.success).toBe(false);
    expect(JSON.stringify(writeIssues.error?.issues)).toContain(
      "Invalid option",
    );
  });

  it("refuses a link write carrying a watch target", () => {
    expect(
      linkMemoryNoteRequestSchema.safeParse({
        kind: "about",
        artifact: aboutTicket.artifact,
        watchTarget: "note",
      }).success,
    ).toBe(false);
  });

  it("resolves a session artifact by its exact incarnation", () => {
    const link = {
      ...aboutTicket,
      artifact: { kind: "session", ...SESSION_INCARNATION },
    };

    expect(memoryLinkSchema.parse(link)).toEqual(link);
    expect(
      memoryLinkSchema.safeParse({
        ...aboutTicket,
        artifact: {
          kind: "session",
          projectPath: SESSION_INCARNATION.projectPath,
          sessionName: SESSION_INCARNATION.sessionName,
        },
      }).success,
    ).toBe(false);
  });
});

describe("memoryNoteRevisionSchema", () => {
  it("carries a full note snapshot", () => {
    const revision = {
      id: "rev-1",
      memoryId: "mem-1",
      revision: 2,
      snapshot: memoryNoteSchema.parse(globalNote({ revision: 2 })),
      origin: "edit",
      baseRevision: 1,
      restoredFromRevision: null,
      authorKind: "agent",
      authorConversationId: "conversation-7",
      createdAt: "2026-09-01T11:00:00.000Z",
    };

    expect(memoryNoteRevisionSchema.parse(revision)).toEqual(revision);
  });
});

describe("memoryChangedEventSchema", () => {
  const frame = {
    type: "memory-changed",
    change: "created",
    memoryId: "mem-1",
    slug: "fts-is-derived",
    scope: "project",
    projectPath: SESSION_INCARNATION.projectPath,
    sessionName: null,
    sessionCreatedAt: null,
    lifecycle: "active",
    revision: 1,
    authorKind: "agent",
    link: null,
  };

  it("accepts the content-free frame", () => {
    expect(memoryChangedEventSchema.parse(frame)).toEqual(frame);
  });

  it("is strict, so envelope metadata and prose never reach the schema", () => {
    expect(
      memoryChangedEventSchema.safeParse({ ...frame, _sentAt: 1 }).success,
    ).toBe(false);
    expect(
      memoryChangedEventSchema.safeParse({ ...frame, hook: "prose" }).success,
    ).toBe(false);
  });

  it("names every mutation the write path and its successors publish", () => {
    expect(memoryChangeKindSchema.options).toEqual([
      "created",
      "updated",
      "linked",
      "unlinked",
      "reviewed",
      "promoted",
      "archived",
      "deleted",
      "restored",
      "proposal-approved",
      "proposal-rejected",
      "superseded",
    ]);
  });
});

describe("memoryActorSchema", () => {
  it("refuses a session incarnation without its project", () => {
    expect(
      memoryActorSchema.safeParse({
        kind: "agent",
        conversationId: "conv-1",
        visibility: {
          projectPath: null,
          session: {
            sessionName: SESSION_INCARNATION.sessionName,
            sessionCreatedAt: SESSION_INCARNATION.sessionCreatedAt,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("proposal decisions state the reviewed revision", () => {
  it("memoryProposalDecisionRequestSchema requires a positive baseRevision", () => {
    const omitted = memoryProposalDecisionRequestSchema.safeParse({});
    expect(omitted.success).toBe(false);
    expect(
      omitted.success ? [] : omitted.error.issues.map((i) => i.path.join(".")),
    ).toContain("baseRevision");
    expect(
      memoryProposalDecisionRequestSchema.safeParse({ baseRevision: null })
        .success,
    ).toBe(false);
    expect(
      memoryProposalDecisionRequestSchema.safeParse({ baseRevision: 0 })
        .success,
    ).toBe(false);
    expect(
      memoryProposalDecisionRequestSchema.parse({ baseRevision: 3 }),
    ).toEqual({ baseRevision: 3 });
  });

  it("the ordinary lifecycle act still defaults an unstated base to null", () => {
    expect(memoryLifecycleActRequestSchema.parse({})).toEqual({
      baseRevision: null,
    });
  });
});

describe("review acts and the review queue (R2, R8)", () => {
  it("markMemoryReviewedRequestSchema targets the note by default, states an optional base, and is strict", () => {
    expect(markMemoryReviewedRequestSchema.parse({})).toEqual({
      target: "note",
      baseRevision: null,
    });
    expect(
      markMemoryReviewedRequestSchema.parse({
        target: "statusNote",
        baseRevision: 4,
      }),
    ).toEqual({ target: "statusNote", baseRevision: 4 });
    // The two lease levels are the whole target vocabulary.
    expect(
      markMemoryReviewedRequestSchema.safeParse({ target: "status" }).success,
    ).toBe(false);
    expect(
      markMemoryReviewedRequestSchema.safeParse({ reviewAfter: "later" })
        .success,
    ).toBe(false);
  });

  it("a state note's default lease is shorter than the status lease", () => {
    expect(MEMORY_STATE_NOTE_LEASE_MS).toBeLessThan(
      MEMORY_STATUS_NOTE_LEASE_MS,
    );
  });

  it("memoryStalenessSchema attributes each cause to what went stale", () => {
    expect(
      memoryStalenessSchema.parse({ cause: "lease", target: "statusNote" }),
    ).toEqual({ cause: "lease", target: "statusNote" });
    expect(memoryStalenessSchema.parse({ cause: "expiry" })).toEqual({
      cause: "expiry",
    });
    expect(
      memoryStalenessSchema.parse({ cause: "lease", target: "note" }),
    ).toEqual({ cause: "lease", target: "note" });
    // Leases and expiry are the only causes: an artifact transition is not one.
    expect(
      memoryStalenessSchema.safeParse({
        cause: "watch",
        target: "note",
        linkId: "link-1",
      }).success,
    ).toBe(false);
  });

  it("memoryReviewQueueEntrySchema carries the note with at least one attributed cause", () => {
    const note = memoryNoteSchema.parse(projectNote());
    const entry = {
      note,
      staleness: [],
      noteReviewDue: false,
      statusReviewDue: false,
      expired: false,
      promotionCandidate: false,
    };
    // Neither stale nor a promotion candidate: nothing queues it, and the
    // refusal names the membership rule rather than a missing field (R10).
    const unqueueable = memoryReviewQueueEntrySchema.safeParse(entry);
    expect(unqueueable.success).toBe(false);
    expect(unqueueable.error?.issues.at(0)?.message).toContain(
      "staleness, promotion candidacy, or both",
    );
    expect(
      memoryReviewQueueEntrySchema.parse({
        ...entry,
        staleness: [{ cause: "lease", target: "note" }],
        noteReviewDue: true,
      }).note.id,
    ).toBe(note.id);
    // A fresh note of a completed session is queued for the promotion decision
    // alone, so candidacy is a queueing cause in its own right.
    expect(
      memoryReviewQueueEntrySchema.parse({ ...entry, promotionCandidate: true })
        .promotionCandidate,
    ).toBe(true);
  });
});

describe("the index budget default (R10.3, D4)", () => {
  it("ships at 20 KiB and 120 hooks, above the frame floor", () => {
    expect(MEMORY_INDEX_BUDGET_DEFAULT_BYTES).toBe(20 * 1024);
    expect(MEMORY_INDEX_BUDGET_DEFAULT_BYTES).toBe(20480);
    expect(MEMORY_INDEX_BUDGET_DEFAULT_HOOKS).toBe(120);
    expect(MEMORY_INDEX_BUDGET_MIN_BYTES).toBeLessThan(
      MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
    );
    expect(
      memoryIndexBudgetSchema.parse({
        bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
        hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
      }),
    ).toEqual({ bytes: 20480, hooks: 120 });
  });
});
