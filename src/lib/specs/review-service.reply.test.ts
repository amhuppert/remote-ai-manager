import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import {
  createSpecReviewRepo,
  type SpecReviewRepo,
} from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createReviewService, type ReviewService } from "./review-service";

const PROJECT_PATH = "/repos/review-reply";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let authoring: AuthoringService;
let reviewing: ReviewService;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  reviewRepo = createSpecReviewRepo(db);
  const specEvents = createSpecEventsRepo(db);
  idSequence = 0;
  timeSequence = 0;
  const deps = {
    specs,
    review: reviewRepo,
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: specEvents.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    attention: specEvents,
    newId(prefix: string) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-08-12T10:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  });
});

afterEach(() => db.close());

/** A proposed revision carrying one human review comment on R1. */
async function proposedSpecWithComment() {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "review-reply",
    name: "Review reply",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "reply-r1",
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "Agents can answer review feedback in place.",
        priority: "must" as const,
        risk: "high" as const,
      },
    },
    actor: AGENT,
  });
  await specs.advanceDraftAuthoringStage({
    specId: created.spec.id,
    revisionId: created.draft.id,
    expectedStage: "requirements",
    targetStage: "design",
  });
  await specs.advanceDraftAuthoringStage({
    specId: created.spec.id,
    revisionId: created.draft.id,
    expectedStage: "design",
    targetStage: "plan",
  });
  for (const element of [
    {
      elementId: "reply-c1",
      kind: "criterion" as const,
      parentElementId: "reply-r1",
      position: 1,
      payload: {
        kind: "criterion" as const,
        text: "A reply lands in the thread it answers.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      elementId: "reply-d1",
      kind: "decision" as const,
      parentElementId: null,
      position: 2,
      payload: {
        kind: "decision" as const,
        title: "Thread ownership",
        chosenApproach: "Replies join the reviewer's thread.",
        rejectedAlternatives: [],
        reason: "The reviewer reads answers where they asked.",
        tracedRequirementElementIds: ["reply-r1"],
      },
    },
    {
      elementId: "reply-t1",
      kind: "task" as const,
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task" as const,
        title: "Implement the reply surface",
        instructions: "Wire the reply verb.",
        tracedRequirementElementIds: ["reply-r1"],
        tracedDecisionElementIds: ["reply-d1"],
        coveredCriterionElementIds: ["reply-c1"],
        dependsOnTaskElementIds: [],
      },
    },
  ]) {
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      ...element,
      baseElementVersion: null,
      actor: AGENT,
    });
  }
  const proposed = await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: AGENT,
  });
  if (!proposed.ok) throw new Error("the fixture propose was refused");
  const commented = await reviewing.comment({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: HUMAN,
    elementId: "reply-r1",
    threadId: "thread-1",
    parentCommentId: null,
    anchor: { quote: "answer review feedback" },
    body: "Which surface answers this feedback?",
    blocking: true,
  });
  if (!commented.ok) throw new Error("the fixture comment was refused");
  return {
    specId: created.spec.id,
    revisionId: created.draft.id,
    root: commented.value,
  };
}

describe("replyToThread", () => {
  it("lets the proposing agent answer a reviewer's thread in place", async () => {
    const { specId, revisionId, root } = await proposedSpecWithComment();

    const replied = await reviewing.replyToThread({
      specId,
      actor: AGENT,
      threadId: "thread-1",
      body: "Repairs land after you Request Changes; answering here meanwhile.",
    });

    expect(replied).toMatchObject({
      ok: true,
      value: {
        thread_id: "thread-1",
        parent_comment_id: root.id,
        element_id: "reply-r1",
        revision_id: revisionId,
        // A reply answers the thread; it never adds a second block.
        blocking: 0,
        resolution: "open",
      },
    });
    if (!replied.ok) throw new Error("the reply was refused");
    expect(JSON.parse(replied.value.author_json)).toEqual(AGENT);

    // Reload through the repository: the thread must now carry both rows in
    // creation order.
    const thread = reviewRepo
      .findCommentsByRevision(revisionId)
      .filter((comment) => comment.thread_id === "thread-1");
    expect(thread.map((comment) => comment.id)).toEqual([
      root.id,
      replied.value.id,
    ]);
  });

  it("keeps the repair loop alive after Request Changes reopens the draft", async () => {
    const { specId, revisionId } = await proposedSpecWithComment();
    const reopened = await reviewing.requestChanges({
      specId,
      revisionId,
      actor: HUMAN,
    });
    expect(reopened.ok).toBe(true);

    const replied = await reviewing.replyToThread({
      specId,
      actor: AGENT,
      threadId: "thread-1",
      body: "Reworded R1 in the reopened draft as asked.",
    });

    expect(replied.ok).toBe(true);
  });

  it("lets a human continue the thread too", async () => {
    const { specId } = await proposedSpecWithComment();

    const replied = await reviewing.replyToThread({
      specId,
      actor: HUMAN,
      threadId: "thread-1",
      body: "Clarifying what I meant by surface.",
    });

    expect(replied.ok).toBe(true);
  });

  it("refuses an unknown thread with the read that lists real ones", async () => {
    const { specId } = await proposedSpecWithComment();

    const replied = await reviewing.replyToThread({
      specId,
      actor: AGENT,
      threadId: "thread-typo",
      body: "Answering nothing.",
    });

    expect(replied).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    if (replied.ok) throw new Error("the reply should have been refused");
    expect(replied.refusal.instruction).toContain("cctl spec comments");
  });

  it("refuses to reopen an ended thread", async () => {
    const { specId, revisionId } = await proposedSpecWithComment();
    const resolved = await reviewing.resolveThread({
      specId,
      revisionId,
      actor: HUMAN,
      threadId: "thread-1",
      resolution: "resolved",
    });
    expect(resolved.ok).toBe(true);

    const replied = await reviewing.replyToThread({
      specId,
      actor: AGENT,
      threadId: "thread-1",
      body: "One more thing…",
    });

    expect(replied).toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });
  });
});
