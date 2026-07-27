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

const PROJECT_PATH = "/repos/native-sdd-questions";
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
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  reviewRepo = createSpecReviewRepo(db);
  const specEvents = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: specEvents.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  idSequence = 0;
  timeSequence = 0;
  const deps = {
    specs,
    review: reviewRepo,
    links: createSpecLinksRepo(db),
    events,
    attention: specEvents,
    newId(prefix: string) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-18T15:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  });
});

afterEach(() => db.close());

async function createPopulatedSpec() {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "questions-assumptions",
    name: "Questions and assumptions",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "Assumptions are explicit.",
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
      elementId: "criterion-1",
      kind: "criterion" as const,
      parentElementId: "requirement-1",
      position: 1,
      payload: {
        kind: "criterion" as const,
        text: "A changed cited assumption requires amendment.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      elementId: "decision-1",
      kind: "decision" as const,
      parentElementId: null,
      position: 2,
      payload: {
        kind: "decision" as const,
        title: "Assumption lifecycle",
        chosenApproach: "Store dispositions.",
        rejectedAlternatives: [],
        reason: "History stays attributable.",
        tracedRequirementElementIds: ["requirement-1"],
      },
    },
    {
      elementId: "task-1",
      kind: "task" as const,
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task" as const,
        title: "Implement lifecycle",
        instructions: "Implement the lifecycle.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: ["decision-1"],
        coveredCriterionElementIds: ["criterion-1"],
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
  return created;
}

describe("ReviewService questions, assumptions, and policy", () => {
  it("moves an addressable question from open to answered while preserving provenance and attachment", async () => {
    const created = await createPopulatedSpec();
    const opened = await reviewing.openQuestion({
      specId: created.spec.id,
      elementId: "requirement-1",
      text: "Which validator proves this?",
      actor: AGENT,
    });
    expect(opened).toMatchObject({
      ok: true,
      value: { number: 1, status: "open", element_id: "requirement-1" },
    });
    if (!opened.ok) throw new Error("question should open");

    const answered = await reviewing.answerQuestion({
      specId: created.spec.id,
      questionId: opened.value.id,
      answer: "The deterministic integration suite.",
      actor: AGENT,
    });
    expect(answered).toMatchObject({
      ok: true,
      value: {
        id: opened.value.id,
        number: 1,
        status: "answered",
        answer: "The deterministic integration suite.",
        answered_at: expect.any(String),
      },
    });
    expect(
      JSON.parse(reviewRepo.findQuestionById(opened.value.id)!.provenance_json),
    ).toEqual(AGENT);
  });

  it("supports human assumption dispositions and refuses changing one cited by approved content", async () => {
    const created = await createPopulatedSpec();
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "decision-1",
      text: "SQLite transactions are available.",
      actor: AGENT,
    });
    expect(proposed).toMatchObject({
      ok: true,
      value: { number: 1, disposition: "proposed" },
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");

    const confirmed = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      disposition: "confirmed",
      actor: HUMAN,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      value: { disposition: "confirmed" },
    });

    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });

    const changed = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      disposition: "rejected",
      actor: HUMAN,
    });
    expect(changed).toMatchObject({
      ok: false,
      refusal: { code: "amendment_required" },
    });
    expect(reviewRepo.findAssumptionById(proposed.value.id)?.disposition).toBe(
      "confirmed",
    );
  });

  it("blocks revision sign-off while a rejected assumption is still cited by spec content (R9.8)", async () => {
    const created = await createPopulatedSpec();
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "requirement-1",
      text: "The retention window is 90 days.",
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");

    // No approved revision cites the assumption yet, so rejecting it is a
    // plain human disposition — the amendment rule does not apply.
    const rejected = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      disposition: "rejected",
      actor: HUMAN,
    });
    expect(rejected).toMatchObject({
      ok: true,
      value: { disposition: "rejected" },
    });

    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });

    const signOff = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signOff).toMatchObject({
      ok: false,
      refusal: {
        code: "lint_blocked",
        findings: [
          expect.objectContaining({
            ruleId: "9.8.rejected-cited-assumption",
            severity: "blocks_signoff",
            elementHandle: "R1",
          }),
        ],
      },
    });
  });

  it("records each supported human disposition on agent-proposed assumptions", async () => {
    const created = await createPopulatedSpec();
    for (const disposition of ["confirmed", "rejected", "deferred"] as const) {
      const proposed = await reviewing.proposeAssumption({
        specId: created.spec.id,
        elementId: null,
        text: `Assumption for ${disposition}.`,
        actor: AGENT,
      });
      if (!proposed.ok) throw new Error("assumption should be proposed");
      const disposed = await reviewing.disposeAssumption({
        specId: created.spec.id,
        assumptionId: proposed.value.id,
        disposition,
        actor: HUMAN,
      });
      expect(disposed).toMatchObject({ ok: true, value: { disposition } });
    }
  });

  it("does not retroactively treat a post-approval assumption as cited by the earlier revision", async () => {
    const created = await createPopulatedSpec();
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });

    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "decision-1",
      text: "This assumption was created after the approved snapshot froze.",
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");
    const firstDisposition = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      disposition: "confirmed",
      actor: HUMAN,
    });
    expect(firstDisposition).toMatchObject({
      ok: true,
      value: { disposition: "confirmed" },
    });

    const amendment = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      actor: AGENT,
    });
    await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      approver: "alex",
      actor: HUMAN,
    });
    const afterCitation = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      disposition: "rejected",
      actor: HUMAN,
    });
    expect(afterCitation).toMatchObject({
      ok: false,
      refusal: { code: "amendment_required" },
    });
  });

  it("applies a hard-confirmed human policy change prospectively without creating approvals", async () => {
    const created = await createPopulatedSpec();
    reviewRepo.saveApproval({
      id: "existing-approval",
      spec_id: created.spec.id,
      subject_kind: "requirement",
      element_id: "requirement-1",
      revision_id: created.draft.id,
      approver: "alex",
      granted_at: "2026-07-18T15:20:00.000Z",
      validity: "valid",
    });
    const refused = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: false,
      actor: HUMAN,
    });
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });

    const changed = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
      actor: HUMAN,
    });
    expect(changed).toMatchObject({
      ok: true,
      value: { spec: { gatePolicy: { preset: "exploratory" } } },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([
      expect.objectContaining({ id: "existing-approval", validity: "valid" }),
    ]);
    expect(reviewRepo.findGateAdmissionsByRevision(created.draft.id)).toEqual(
      [],
    );
  });
});
