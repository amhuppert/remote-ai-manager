import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  alignmentDecisionSchema,
  alignmentVersionSchema,
  decisionProposalSchema,
  type AlignmentDecision,
  type AlignmentVersion,
  type DecisionProposal,
} from "@/lib/session-alignment/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: SessionAlignmentRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: "/wt/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  createSessionsRepo(db).upsert(PROJECT_PATH, makeSession());
  repo = createSessionAlignmentRepo(db);
});

afterEach(() => {
  db.close();
});

/**
 * A maximal charter version with EVERY introspectable persisted key path
 * populated to a distinctive non-default value, so the schema-driven durability
 * harness proves no field is dropped on write or reset to its default on read.
 * The nullable `version`/`activatedAt`/`approver`/`authorConversationId`
 * columns are all set to a non-null value, and `linkedDecisionIds` (stored as
 * JSON text) carries multiple ids so the JSON serialization round-trips.
 */
function buildMaximalVersion(): AlignmentVersion {
  return alignmentVersionSchema.parse({
    id: "ver-maximal",
    version: 5,
    content: "# Mission\nGovern the session with a maximal charter.",
    contentHash: "sha256-maximal",
    status: "active",
    source: "decision",
    authorConversationId: "conv-author",
    autoActivate: true,
    linkedDecisionIds: ["dec-a", "dec-b"],
    createdAt: "2026-02-15T08:09:10Z",
    activatedAt: "2026-02-15T09:00:00Z",
    approver: "alex",
  });
}

/**
 * A maximal approved decision with every persisted column populated to a
 * distinctive non-default value, including the nullable `rationale`,
 * `originMessageId`, `producedVersion`, and `approver`.
 */
function buildMaximalDecision(): AlignmentDecision {
  return alignmentDecisionSchema.parse({
    id: "dec-maximal",
    statement: "Adopt the maximal storage backstop.",
    rationale: "Durability is non-negotiable for the decision log.",
    originConversationId: "conv-origin",
    originMessageId: "msg-origin",
    producedVersion: 5,
    approver: "alex",
    approvedAt: "2026-02-15T08:10:00Z",
    createdAt: "2026-02-15T08:10:00Z",
  });
}

/**
 * A maximal pending proposal with every persisted column populated, including
 * the nullable `rationale`, `context`, and `originMessageId`.
 */
function buildMaximalProposal(): DecisionProposal {
  return decisionProposalSchema.parse({
    id: "prop-maximal",
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: "conv-proposer",
    batchId: "batch-maximal",
    statement: "Propose the maximal decision for review.",
    rationale: "Captures the agent's reasoning before approval.",
    context: "Surfaced during a deep refactor of the alignment domain.",
    originMessageId: "msg-proposal",
    createdAt: "2026-02-15T08:11:00Z",
  });
}

describe("session-alignment repo durability contract — versions", () => {
  it("round-trips every persisted version key path through the real store", async () => {
    await assertRoundTripDurability({
      label: "session-alignment-versions",
      schema: alignmentVersionSchema,
      buildMaximalFixture: buildMaximalVersion,
      persist: (fixture) => {
        repo.insertVersion(PROJECT_PATH, SESSION_NAME, fixture);
        return fixture;
      },
      reload: (expected) => repo.findVersionById(expected.id),
      // Every schema field maps to a dedicated column written from the
      // caller-supplied value. The nullable columns
      // (`version`/`activatedAt`/`approver`/`authorConversationId`) are
      // populated non-null in the maximal fixture, and `linkedDecisionIds` is
      // serialized as JSON text and restored to a string[] — no field is
      // runtime-only or write-derived, so the policy map is empty.
      fieldPolicies: {},
    });
  });
});

describe("session-alignment repo durability contract — decisions", () => {
  it("round-trips every persisted decision key path through the real store", async () => {
    await assertRoundTripDurability({
      label: "session-alignment-decisions",
      schema: alignmentDecisionSchema,
      buildMaximalFixture: buildMaximalDecision,
      persist: (fixture) => {
        repo.appendDecision(PROJECT_PATH, SESSION_NAME, fixture);
        return fixture;
      },
      reload: (expected) => repo.findDecisionById(expected.id),
      // `producedVersion`, `rationale`, `originMessageId`, and `approver` are
      // nullable columns populated non-null in the maximal fixture; every other
      // field is a required scalar column. No runtime-only or write-derived
      // fields, so the policy map is empty.
      fieldPolicies: {},
    });
  });
});

describe("session-alignment repo durability contract — proposals", () => {
  it("round-trips every persisted proposal key path through the real store", async () => {
    await assertRoundTripDurability({
      label: "session-alignment-decision-proposals",
      schema: decisionProposalSchema,
      buildMaximalFixture: buildMaximalProposal,
      persist: (fixture) => {
        repo.insertProposals([fixture]);
        return fixture;
      },
      reload: (expected) => repo.findProposalById(expected.id),
      // `rationale`, `context`, and `originMessageId` are nullable columns
      // populated non-null in the maximal fixture; `projectPath`/`sessionName`
      // are persisted identity columns. No runtime-only or write-derived
      // fields, so the policy map is empty.
      fieldPolicies: {},
    });
  });
});

describe("session-alignment repo — version reads", () => {
  it("finds the single active version, distinct from draft and superseded", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, buildMaximalVersion());
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-draft",
      version: null,
      status: "draft",
      activatedAt: null,
      approver: null,
    });
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-old",
      version: 4,
      status: "superseded",
    });

    expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      "ver-maximal",
    );
    expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      "ver-draft",
    );
    expect(repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(5);
  });

  it("returns null active/draft when none exist", () => {
    expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("finds a version by its activation number", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-3",
      version: 3,
      status: "superseded",
    });
    expect(repo.findVersionByNumber(PROJECT_PATH, SESSION_NAME, 3)?.id).toBe(
      "ver-3",
    );
    expect(repo.findVersionByNumber(PROJECT_PATH, SESSION_NAME, 99)).toBeNull();
  });

  it("returns the version history (superseded + active) newest first, excluding drafts", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-1",
      version: 1,
      status: "superseded",
    });
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-2",
      version: 2,
      status: "active",
    });
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-draft",
      version: null,
      status: "draft",
    });

    const history = repo.findVersionHistory(PROJECT_PATH, SESSION_NAME);
    expect(history.map((v) => v.id)).toEqual(["ver-2", "ver-1"]);
  });

  it("updates an existing version in place (draft fill / activation transition)", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-fill",
      version: null,
      content: "",
      contentHash: "",
      status: "draft",
      activatedAt: null,
      approver: null,
    });

    repo.updateVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-fill",
      version: 1,
      content: "# Mission\nfilled",
      contentHash: "sha256-filled",
      status: "active",
      activatedAt: "2026-03-01T00:00:00Z",
      approver: "alex",
    });

    const reloaded = repo.findVersionById("ver-fill");
    expect(reloaded?.status).toBe("active");
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.content).toBe("# Mission\nfilled");
  });

  it("round-trips an empty linkedDecisionIds array (not coerced to null or dropped)", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalVersion(),
      id: "ver-no-links",
      linkedDecisionIds: [],
    });

    expect(repo.findVersionById("ver-no-links")?.linkedDecisionIds).toEqual([]);
  });
});

describe("session-alignment repo — append-only decision log", () => {
  it("returns approved decisions in reverse-chronological order", () => {
    repo.appendDecision(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalDecision(),
      id: "dec-old",
      approvedAt: "2026-01-01T00:00:00Z",
    });
    repo.appendDecision(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalDecision(),
      id: "dec-new",
      approvedAt: "2026-02-01T00:00:00Z",
    });

    const log = repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME);
    expect(log.map((d) => d.id)).toEqual(["dec-new", "dec-old"]);
  });

  it("does not expose any update or delete of logged decisions on the repo surface", () => {
    const surface = repo as unknown as Record<string, unknown>;
    expect(surface.updateDecision).toBeUndefined();
    expect(surface.deleteDecision).toBeUndefined();
  });

  it("sets a decision's produced_version when its linked draft activates", () => {
    repo.appendDecision(PROJECT_PATH, SESSION_NAME, {
      ...buildMaximalDecision(),
      id: "dec-link",
      producedVersion: null,
    });

    repo.setDecisionProducedVersion(PROJECT_PATH, SESSION_NAME, "dec-link", 7);

    expect(repo.findDecisionById("dec-link")?.producedVersion).toBe(7);
  });
});

describe("session-alignment repo — proposal batches", () => {
  it("persists a batch, reads it by batchId, and deletes it on resolution", () => {
    const a = { ...buildMaximalProposal(), id: "p-a", batchId: "batch-1" };
    const b = { ...buildMaximalProposal(), id: "p-b", batchId: "batch-1" };
    const other = {
      ...buildMaximalProposal(),
      id: "p-c",
      batchId: "batch-2",
    };
    repo.insertProposals([a, b, other]);

    const batch1 = repo.findProposalsByBatch(
      PROJECT_PATH,
      SESSION_NAME,
      "batch-1",
    );
    expect(batch1.map((p) => p.id).sort()).toEqual(["p-a", "p-b"]);

    repo.deleteProposalsByBatch(PROJECT_PATH, SESSION_NAME, "batch-1");
    expect(
      repo.findProposalsByBatch(PROJECT_PATH, SESSION_NAME, "batch-1"),
    ).toEqual([]);
    expect(
      repo
        .findProposalsByBatch(PROJECT_PATH, SESSION_NAME, "batch-2")
        .map((p) => p.id),
    ).toEqual(["p-c"]);
  });

  it("lists pending proposal batches grouped by batchId", () => {
    repo.insertProposals([
      { ...buildMaximalProposal(), id: "p-a", batchId: "batch-1" },
      { ...buildMaximalProposal(), id: "p-b", batchId: "batch-1" },
      { ...buildMaximalProposal(), id: "p-c", batchId: "batch-2" },
    ]);

    const batches = repo.findPendingProposalBatches(PROJECT_PATH, SESSION_NAME);
    const byId = new Map(batches.map((b) => [b.batchId, b]));
    expect(new Set(byId.keys())).toEqual(new Set(["batch-1", "batch-2"]));
    expect(
      byId
        .get("batch-1")
        ?.proposals.map((p) => p.id)
        .sort(),
    ).toEqual(["p-a", "p-b"]);
  });
});

describe("session-alignment repo — conversation seen-version accessor", () => {
  function seedConversation(id: string): void {
    createConversationsRepo(db).upsert(
      PROJECT_PATH,
      SESSION_NAME,
      conversationStateSchema.parse({
        id,
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
  }

  it("defaults a freshly-created conversation's seen-version to null", () => {
    seedConversation("conv-seen");
    expect(repo.getConversationSeenVersion("conv-seen")).toBeNull();
  });

  it("writes and reads back a conversation's seen-version", () => {
    seedConversation("conv-seen");

    repo.setConversationSeenVersion("conv-seen", 4);
    expect(repo.getConversationSeenVersion("conv-seen")).toBe(4);

    repo.setConversationSeenVersion("conv-seen", 7);
    expect(repo.getConversationSeenVersion("conv-seen")).toBe(7);
  });

  it("returns null for an unknown conversation id", () => {
    expect(repo.getConversationSeenVersion("does-not-exist")).toBeNull();
  });
});

describe("session-alignment repo — cascading-FK invariant", () => {
  it("deleting a session cascades to its alignment rows", () => {
    repo.insertVersion(PROJECT_PATH, SESSION_NAME, buildMaximalVersion());
    repo.appendDecision(PROJECT_PATH, SESSION_NAME, buildMaximalDecision());
    repo.insertProposals([buildMaximalProposal()]);

    createSessionsRepo(db).delete(PROJECT_PATH, SESSION_NAME);

    expect(repo.findVersionById("ver-maximal")).toBeNull();
    expect(repo.findDecisionById("dec-maximal")).toBeNull();
    expect(repo.findProposalById("prop-maximal")).toBeNull();
  });
});
