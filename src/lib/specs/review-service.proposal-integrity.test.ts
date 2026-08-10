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
import type { SpecRevisionState } from "./schemas";

const PROJECT_PATH = "/repos/proposal-integrity";
const PROPOSER = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let specEvents: ReturnType<typeof createSpecEventsRepo>;
let authoring: AuthoringService;
let reviewing: ReviewService;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  reviewRepo = createSpecReviewRepo(db);
  specEvents = createSpecEventsRepo(db);
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
      return `2026-08-06T10:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  });
});

afterEach(() => db.close());

/** A fast-path spec whose first revision is proposed and ready to sign off. */
async function proposedSpec(slug: string) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug,
    name: `Proposal integrity ${slug}`,
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: `${slug}-r1`,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "A stranded proposal always has an exit.",
        priority: "must",
        risk: "high",
      },
    },
    actor: PROPOSER,
  });
  await authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: `${slug}-c1`,
    kind: "criterion",
    parentElementId: `${slug}-r1`,
    position: 1,
    payload: {
      kind: "criterion",
      text: "The dismiss act opens no draft.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: PROPOSER,
  });
  const proposed = await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: PROPOSER,
  });
  if (!proposed.ok) throw new Error("the fixture propose was refused");
  return { specId: created.spec.id, revisionId: created.draft.id };
}

/** A revision cloned off `baseRevisionId` and driven straight to `proposed`. */
async function proposeSibling(
  specId: string,
  baseRevisionId: string,
  id: string,
) {
  await specs.createDraftFromBase({
    id,
    specId,
    baseRevisionId,
    authoringStage: "design",
    createdAt: "2026-08-06T09:00:00.000Z",
  });
  return specs.proposeRevision({
    revisionId: id,
    proposedAt: "2026-08-06T09:00:01.000Z",
  });
}

async function stateOf(revisionId: string): Promise<SpecRevisionState> {
  const revision = await specs.findRevision(revisionId);
  if (revision === null) throw new Error(`revision ${revisionId} is gone`);
  return revision.state;
}

/**
 * Ticket #50's live shape, rebuilt at the repository so it exists even though
 * the propose guard now prevents it from forming: an approved revision, a
 * proposal based on it, and a second proposal that also forks off it.
 */
async function strandedLineage(slug: string) {
  const { specId, revisionId } = await proposedSpec(slug);
  const signedOff = await reviewing.signOffRevision({
    specId,
    revisionId,
    actor: HUMAN,
    approver: "operator",
  });
  if (!signedOff.ok) throw new Error("the fixture sign-off was refused");
  const stranded = await proposeSibling(
    specId,
    revisionId,
    `${slug}-revision-stranded`,
  );
  const successor = await proposeSibling(
    specId,
    revisionId,
    `${slug}-revision-successor`,
  );
  return { specId, approvedId: revisionId, stranded, successor };
}

describe("signOffRevision live-sibling recheck", () => {
  it("refuses when the sign-off would fork past a live sibling, naming it and the dismiss remedy", async () => {
    const { specId, stranded, successor } = await strandedLineage("recheck");

    const result = await reviewing.signOffRevision({
      specId,
      revisionId: successor.id,
      actor: HUMAN,
      approver: "operator",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the sign-off to refuse");
    expect(result.refusal.code).toBe("revision_in_review");
    expect(result.refusal.unmetConditions.join(" ")).toContain(stranded.id);
    expect(result.refusal.unmetConditions.join(" ")).toContain(
      `revision ${stranded.number}`,
    );
    expect(result.refusal.instruction).toContain("Dismiss superseded proposal");
    expect(result.refusal.instruction).toContain(stranded.id);
  });

  it("disposes of nothing when it refuses", async () => {
    const { specId, stranded, successor } = await strandedLineage("no-dispose");

    await reviewing.signOffRevision({
      specId,
      revisionId: successor.id,
      actor: HUMAN,
      approver: "operator",
    });

    expect(await stateOf(stranded.id)).toBe("proposed");
    expect(await stateOf(successor.id)).toBe("proposed");
  });

  it("disposes of no sibling revision when it commits", async () => {
    const { specId, revisionId } = await proposedSpec("clean-sign-off");
    const abandoned = await proposeSibling(
      specId,
      revisionId,
      "clean-revision-abandoned",
    );
    await specs.withdrawRevision({ revisionId: abandoned.id });

    const result = await reviewing.signOffRevision({
      specId,
      revisionId,
      actor: HUMAN,
      approver: "operator",
    });

    expect(result.ok).toBe(true);
    expect(await stateOf(revisionId)).toBe("approved");
    expect(await stateOf(abandoned.id)).toBe("withdrawn");
  });
});

describe("dismissSupersededProposal", () => {
  const REASON = "Revision 3 was approved from an earlier base.";

  it("ends the forked-past proposal as superseded without opening a draft", async () => {
    const { specId, stranded, successor } = await strandedLineage("dismiss");
    await specs.approveRevision({
      revisionId: successor.id,
      approvedAt: "2026-08-06T09:30:00.000Z",
    });

    const result = await reviewing.dismissSupersededProposal({
      specId,
      revisionId: stranded.id,
      reason: REASON,
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the dismissal to commit");
    expect(result.value.withdrawn.state).toBe("withdrawn");
    expect(result.value.supersession).toMatchObject({
      revisionId: stranded.id,
      specId,
      supersededByRevisionId: successor.id,
      reason: REASON,
      actor: HUMAN,
    });
    // Deliberately not withdrawAndOpenDraft: resurrecting the stale content
    // as the spec's only editable revision is #50 gap 2.
    expect(await specs.findDraft(specId)).toBeNull();
    expect(
      (await specs.listRevisions(specId)).map((revision) => revision.state),
    ).toEqual(["approved", "withdrawn", "approved"]);
  });

  it("writes the durable audit event in the same transaction as the state change", async () => {
    const { specId, stranded, successor } = await strandedLineage("audit");
    await specs.approveRevision({
      revisionId: successor.id,
      approvedAt: "2026-08-06T09:30:00.000Z",
    });

    await reviewing.dismissSupersededProposal({
      specId,
      revisionId: stranded.id,
      reason: REASON,
      actor: HUMAN,
    });

    const payloads = specEvents
      .findBySpecId(specId)
      .filter((event) => event.event_type === "spec-revision-changed")
      .map((event) => ({
        actor: JSON.parse(event.actor_json) as unknown,
        payload: JSON.parse(event.payload_json) as {
          kind: string;
          revisionId?: string;
          supersededByRevisionId?: string;
          reason?: string;
        },
      }))
      .filter(
        ({ payload }) => payload.kind === "proposal-dismissed-superseded",
      );
    expect(payloads).toEqual([
      {
        actor: HUMAN,
        payload: {
          kind: "proposal-dismissed-superseded",
          revisionId: stranded.id,
          supersededByRevisionId: successor.id,
          reason: REASON,
        },
      },
    ]);
  });

  it("disposes of no sibling proposal", async () => {
    const { specId, stranded, successor } = await strandedLineage("siblings");
    await specs.approveRevision({
      revisionId: successor.id,
      approvedAt: "2026-08-06T09:30:00.000Z",
    });
    const bystander = await proposeSibling(
      specId,
      successor.id,
      "siblings-revision-bystander",
    );

    await reviewing.dismissSupersededProposal({
      specId,
      revisionId: stranded.id,
      reason: REASON,
      actor: HUMAN,
    });

    expect(await stateOf(bystander.id)).toBe("proposed");
    expect(await specs.findSupersession(bystander.id)).toBeNull();
  });

  it("refuses the current proposal — nothing has forked past it", async () => {
    const { specId, revisionId } = await proposedSpec("current");

    const result = await reviewing.dismissSupersededProposal({
      specId,
      revisionId,
      reason: REASON,
      actor: HUMAN,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the dismissal to refuse");
    expect(result.refusal.code).toBe("gate_blocked");
    expect(result.refusal.unmetConditions.join(" ")).toContain(
      "no approved revision has forked past",
    );
    expect(result.refusal.instruction).toContain("Request Changes");
    expect(await stateOf(revisionId)).toBe("proposed");
  });

  it("refuses while the later revision is still only proposed", async () => {
    const { specId, stranded, successor } = await strandedLineage("unapproved");

    const result = await reviewing.dismissSupersededProposal({
      specId,
      revisionId: stranded.id,
      reason: REASON,
      actor: HUMAN,
    });

    expect(result.ok).toBe(false);
    expect(await stateOf(stranded.id)).toBe("proposed");
    expect(await stateOf(successor.id)).toBe("proposed");
  });

  it("refuses when the later approved revision descends from the proposal", async () => {
    const { specId, revisionId } = await proposedSpec("descendant");
    const descendant = await proposeSibling(
      specId,
      revisionId,
      "descendant-revision-child",
    );
    await specs.approveRevision({
      revisionId: descendant.id,
      approvedAt: "2026-08-06T09:30:00.000Z",
    });

    const result = await reviewing.dismissSupersededProposal({
      specId,
      revisionId,
      reason: REASON,
      actor: HUMAN,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the dismissal to refuse");
    expect(result.refusal.unmetConditions.join(" ")).toContain(
      "no approved revision has forked past",
    );
    expect(await stateOf(revisionId)).toBe("proposed");
  });

  it("refuses an agent caller and names the Studio Review surface", async () => {
    const { specId, stranded, successor } = await strandedLineage("agent");
    await specs.approveRevision({
      revisionId: successor.id,
      approvedAt: "2026-08-06T09:30:00.000Z",
    });

    const result = await reviewing.dismissSupersededProposal({
      specId,
      revisionId: stranded.id,
      reason: REASON,
      actor: PROPOSER,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the dismissal to refuse");
    expect(result.refusal.code).toBe("human_act_required");
    expect(result.refusal.instruction).toContain("Spec Studio → Review");
    expect(await stateOf(stranded.id)).toBe("proposed");
  });
});
