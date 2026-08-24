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
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";
import type { ActorProvenance } from "@/lib/specs/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import {
  createReviewService,
  type ReviewService,
  type SpecReviewFeedbackNotice,
  type SpecReviewNotifier,
} from "./review-service";

const PROJECT_PATH = "/repos/review-feedback";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let authoring: AuthoringService;
let reviewing: ReviewService;
let feedbackNotices: SpecReviewFeedbackNotice[];
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  const specEvents = createSpecEventsRepo(db);
  idSequence = 0;
  timeSequence = 0;
  feedbackNotices = [];
  // A recording double injected through the service's notifier port (DI).
  const notifier: SpecReviewNotifier = {
    approvalRequested() {},
    approvalGranted() {},
    approvalRequestsClosed() {},
    reviewFeedback(notice) {
      feedbackNotices.push(notice);
    },
  };
  const deps = {
    specs,
    review: createSpecReviewRepo(db),
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
    notifier,
  });
});

afterEach(() => db.close());

/** A fully-authored revision proposed by `proposer`, with no review comments. */
async function proposedSpec(proposer: ActorProvenance) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "review-feedback",
    name: "Review feedback",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "fb-r1",
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "The proposing conversation hears about review feedback.",
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
      elementId: "fb-c1",
      kind: "criterion" as const,
      parentElementId: "fb-r1",
      position: 1,
      payload: {
        kind: "criterion" as const,
        text: "A feedback notice reaches the proposer's conversation.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      elementId: "fb-d1",
      kind: "decision" as const,
      parentElementId: null,
      position: 2,
      payload: {
        kind: "decision" as const,
        title: "Passive delivery",
        chosenApproach: "Durable notices, never an auto-wake.",
        rejectedAlternatives: [],
        reason: "The proposer reads feedback on its own next turn.",
        tracedRequirementElementIds: ["fb-r1"],
      },
    },
    {
      elementId: "fb-t1",
      kind: "task" as const,
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task" as const,
        title: "Deliver the notice",
        instructions: "Append the transcript and agent notices.",
        tracedRequirementElementIds: ["fb-r1"],
        tracedDecisionElementIds: ["fb-d1"],
        coveredCriterionElementIds: ["fb-c1"],
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
    actor: proposer,
  });
  if (!proposed.ok) throw new Error("the fixture propose was refused");
  return { specId: created.spec.id, revisionId: created.draft.id };
}

async function humanComment(specId: string, revisionId: string) {
  const commented = await reviewing.comment({
    specId,
    revisionId,
    actor: HUMAN,
    elementId: "fb-r1",
    threadId: "thread-1",
    parentCommentId: null,
    anchor: {
      sectionId: "requirements",
      headingLabel: "Requirements",
      line: 1,
      charStart: 0,
      charEnd: 15,
      quote: "review feedback",
      prefix: "",
      suffix: "",
      docRevision: revisionId,
    },
    body: "Where does the proposer read this?",
    blocking: false,
  });
  if (!commented.ok) throw new Error("the fixture comment was refused");
  return commented.value;
}

describe("review feedback notices to the proposing conversation", () => {
  it("notifies the proposer once when a human comments on an agent-proposed revision", async () => {
    const { specId, revisionId } = await proposedSpec(AGENT);

    await humanComment(specId, revisionId);

    expect(feedbackNotices).toHaveLength(1);
    expect(feedbackNotices[0]).toMatchObject({
      kind: "commented",
      specSlug: "review-feedback",
      specName: "Review feedback",
      projectPath: PROJECT_PATH,
      revisionId,
      subject: "fb-r1",
      threadId: "thread-1",
      proposer: { kind: "agent", conversationId: "conversation-1" },
    });
  });

  it("skips the agent's own reply and notifies on a human reply", async () => {
    const { specId, revisionId } = await proposedSpec(AGENT);
    await humanComment(specId, revisionId);
    feedbackNotices.length = 0;

    const agentReplied = await reviewing.replyToThread({
      specId,
      actor: AGENT,
      threadId: "thread-1",
      body: "Answering my reviewer.",
    });
    expect(agentReplied.ok).toBe(true);
    expect(feedbackNotices).toHaveLength(0);

    const humanReplied = await reviewing.replyToThread({
      specId,
      actor: HUMAN,
      threadId: "thread-1",
      body: "Clarifying what I meant.",
    });
    expect(humanReplied.ok).toBe(true);
    expect(feedbackNotices).toHaveLength(1);
    expect(feedbackNotices[0]).toMatchObject({
      kind: "commented",
      revisionId,
      subject: "fb-r1",
      threadId: "thread-1",
      proposer: { kind: "agent", conversationId: "conversation-1" },
    });
  });

  it("reports changes_requested when the draft reopens", async () => {
    const { specId, revisionId } = await proposedSpec(AGENT);
    await humanComment(specId, revisionId);
    feedbackNotices.length = 0;

    const reopened = await reviewing.requestChanges({
      specId,
      revisionId,
      actor: HUMAN,
    });
    expect(reopened.ok).toBe(true);

    expect(feedbackNotices).toHaveLength(1);
    expect(feedbackNotices[0]).toMatchObject({
      kind: "changes_requested",
      specSlug: "review-feedback",
      revisionId,
      subject: null,
      threadId: null,
      proposer: { kind: "agent", conversationId: "conversation-1" },
    });
  });

  /**
   * The agent that has to act on the feedback is the one that mistakes a
   * reopen for a loss, so the carry travels in the notice it reads — not only
   * in the response the acting human sees.
   */
  it("carries the reopened draft's ledger and the carry rule into the feedback the proposer reads", async () => {
    const { specId, revisionId } = await proposedSpec(AGENT);
    const approved = await reviewing.approveItem({
      specId,
      revisionId,
      subjectKind: "requirement",
      elementId: "fb-r1",
      approver: "alex",
      actor: HUMAN,
    });
    expect(approved.ok).toBe(true);
    feedbackNotices.length = 0;

    const reopened = await reviewing.requestChanges({
      specId,
      revisionId,
      actor: HUMAN,
    });

    if (!reopened.ok) throw new Error("the request for changes was refused");
    // R1 is unchanged, so the approval a human granted on the withdrawn
    // revision still stands for the draft that replaced it.
    expect(reopened.value.approvalLedger).toMatchObject({
      satisfied: 1,
      carried: 1,
      currentRevision: 0,
      carryRule: "unchanged subject content under the same applicable gate",
    });
    expect(
      reopened.value.approvalLedger.subjects.map(
        ({ subject, classification }) => [subject, classification],
      ),
    ).toEqual([
      ["R1", "carried"],
      ["D1", "pending"],
    ]);
    expect(feedbackNotices).toHaveLength(1);
    expect(feedbackNotices[0]?.approvalLedger).toEqual(
      reopened.value.approvalLedger,
    );
  });

  it("reports signed_off once, not again on the idempotent repeat", async () => {
    const { specId, revisionId } = await proposedSpec(AGENT);
    feedbackNotices.length = 0;

    const signedOff = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      actor: HUMAN,
      approver: "alex",
    });
    expect(signedOff.ok).toBe(true);
    expect(feedbackNotices).toHaveLength(1);
    expect(feedbackNotices[0]).toMatchObject({
      kind: "signed_off",
      specSlug: "review-feedback",
      revisionId,
      subject: null,
      threadId: null,
      proposer: { kind: "agent", conversationId: "conversation-1" },
    });

    const repeated = await reviewing.signOffRevision({
      specId,
      revisionId,
      actor: HUMAN,
      approver: "alex",
    });
    expect(repeated.ok).toBe(true);
    expect(feedbackNotices).toHaveLength(1);
  });

  it("stays silent for a human-proposed revision", async () => {
    const { specId, revisionId } = await proposedSpec(HUMAN);

    await humanComment(specId, revisionId);

    expect(feedbackNotices).toHaveLength(0);
  });
});
