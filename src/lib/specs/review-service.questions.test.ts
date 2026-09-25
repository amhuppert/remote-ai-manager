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
import { revisionReviewHash } from "./review-hash";
import { createReviewService, type ReviewService } from "./review-service";

const PROJECT_PATH = "/repos/native-sdd-questions";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const LATER_AGENT = {
  kind: "agent",
  conversationId: "conversation-2",
} as const;
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

async function reviewHash(revisionId: string): Promise<string> {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) throw new Error(`revision ${revisionId} missing`);
  return revisionReviewHash(snapshot);
}

/** Approves every consulted subject on the open draft, then signs it off. */
async function approveAndSignOff(specId: string, revisionId: string) {
  const approved = await reviewing.bulkApprove({
    specId,
    revisionId,
    subjects: [
      { subjectKind: "requirement", elementId: "requirement-1" },
      { subjectKind: "decision", elementId: "decision-1" },
      { subjectKind: "plan", elementId: null },
    ],
    approver: "alex",
    expectedReviewHash: await reviewHash(revisionId),
    actor: HUMAN,
  });
  if (!approved.ok) throw new Error(approved.refusal.code);
  return reviewing.signOffRevision({
    specId,
    revisionId,
    approver: "alex",
    expectedReviewHash: await reviewHash(revisionId),
    actor: HUMAN,
  });
}

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
    if (element.kind === "decision") {
      await specs.advanceDraftAuthoringStage({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedStage: "requirements",
        targetStage: "design",
      });
    }
    if (element.kind === "task") {
      await specs.advanceDraftAuthoringStage({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedStage: "design",
        targetStage: "plan",
      });
    }
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
  it("admits later authoring-agent correction, human terminal acts, and no terminal rewrites", async () => {
    const created = await createPopulatedSpec();
    const opened = await reviewing.openQuestion({
      specId: created.spec.id,
      elementId: "requirement-1",
      text: "Which validator proves this?",
      actor: AGENT,
    });
    if (!opened.ok) throw new Error("question should open");
    expect(opened.value.record_version).toBe(1);

    await expect(
      reviewing.editAttentionRecord({
        specId: created.spec.id,
        recordId: opened.value.id,
        expectedRecordVersion: 1,
        payload: { kind: "question", text: "Human rewrite" },
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "authoring_agent_required" },
    });
    await expect(
      reviewing.editAttentionRecord({
        specId: created.spec.id,
        recordId: opened.value.id,
        expectedRecordVersion: 1,
        payload: {
          kind: "question",
          text: "Which deterministic validator proves this?",
        },
        actor: LATER_AGENT,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        operation: "edited",
        previousRecordVersion: 1,
        newRecordVersion: 2,
      },
    });
    await expect(
      reviewing.editAttentionRecord({
        specId: created.spec.id,
        recordId: opened.value.id,
        expectedRecordVersion: 1,
        payload: { kind: "question", text: "Stale rewrite" },
        actor: AGENT,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "stale_attention_record" },
    });
    await expect(
      reviewing.answerQuestion({
        specId: created.spec.id,
        questionId: opened.value.id,
        recordVersion: 2,
        answer: "Agents cannot decide the human answer.",
        actor: LATER_AGENT,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    await expect(
      reviewing.answerQuestion({
        specId: created.spec.id,
        questionId: opened.value.id,
        recordVersion: 2,
        answer: "The deterministic integration suite.",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "answered", record_version: 3 },
    });
    await expect(
      reviewing.editAttentionRecord({
        specId: created.spec.id,
        recordId: opened.value.id,
        expectedRecordVersion: 3,
        payload: { kind: "question", text: "Rewrite terminal answer" },
        actor: AGENT,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "attention_state_conflict" },
    });

    const events = db
      .prepare(
        `SELECT event_type FROM spec_events
         WHERE spec_id = ? AND event_type = 'spec-review-record-mutated'
         ORDER BY id`,
      )
      .all(created.spec.id);
    expect(events).toHaveLength(3);
  });

  it("refreshes cited snapshots, supersedes once, replays, and withdraws current truth", async () => {
    const created = await createPopulatedSpec();
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "requirement-1",
      text: "The validator is deterministic.",
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");
    expect(proposed.value.record_version).toBe(1);
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      citationVersion: 2,
    });

    await expect(
      reviewing.editAttentionRecord({
        specId: created.spec.id,
        recordId: proposed.value.id,
        expectedRecordVersion: 1,
        expectedCitationVersion: 2,
        payload: {
          kind: "assumption",
          text: "The validator is deterministic and durable.",
        },
        actor: LATER_AGENT,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        previousRecordVersion: 1,
        newRecordVersion: 2,
        previousCitationVersion: 2,
        newCitationVersion: 3,
      },
    });
    expect(
      (await specs.readRevisionCitations(created.draft.id))[0]?.snapshot.text,
    ).toBe("The validator is deterministic and durable.");

    await expect(
      reviewing.disposeAssumption({
        specId: created.spec.id,
        assumptionId: proposed.value.id,
        recordVersion: 2,
        citationVersion: 3,
        disposition: "confirmed",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { disposition: "confirmed", record_version: 3 },
    });
    await expect(
      reviewing.disposeAssumption({
        specId: created.spec.id,
        assumptionId: proposed.value.id,
        recordVersion: 3,
        citationVersion: 4,
        disposition: "rejected",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "attention_state_conflict" },
    });

    const supersedeInput = {
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      draftRevisionId: created.draft.id,
      expectedRecordVersion: 3,
      expectedCitationVersion: 4,
      payload: {
        operationId: "supersede-operation",
        reason: "The confirmed premise needs correction.",
        text: "The validator is deterministic under a pinned revision.",
        attachment: { kind: "element" as const, handle: "R1" },
        citations: {
          kind: "replace" as const,
          elementHandles: ["R1"],
        },
      },
      actor: LATER_AGENT,
    };
    const superseded = await reviewing.supersedeAssumption(supersedeInput);
    expect(superseded).toMatchObject({
      ok: true,
      value: {
        operation: "superseded",
        newRecordVersion: 4,
        newCitationVersion: 5,
        successor: { handle: "A2" },
        idempotentReplay: false,
      },
    });
    await expect(
      reviewing.supersedeAssumption(supersedeInput),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        successor: { handle: "A2" },
        idempotentReplay: true,
      },
    });
    await expect(
      reviewing.supersedeAssumption({
        ...supersedeInput,
        payload: { ...supersedeInput.payload, text: "Conflicting retry" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "idempotency_conflict" },
    });

    if (!superseded.ok || superseded.value.successor === undefined) {
      throw new Error("supersession should return its successor");
    }
    await expect(
      reviewing.withdrawAttentionRecord({
        specId: created.spec.id,
        recordId: superseded.value.successor.id,
        expectedRecordVersion: 1,
        expectedCitationVersion: 5,
        reason: "This successor is no longer needed.",
        actor: LATER_AGENT,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        operation: "withdrawn",
        lifecycle: "withdrawn",
        newCitationVersion: 6,
      },
    });
    expect(await specs.readRevisionCitations(created.draft.id)).toEqual([]);

    const replayWithoutRevision = {
      ...supersedeInput,
      draftRevisionId: undefined,
    };
    await expect(
      reviewing.supersedeAssumption(replayWithoutRevision),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        successor: { handle: "A2" },
        newRecordVersion: 4,
        newCitationVersion: 6,
        idempotentReplay: true,
      },
    });
    await expect(
      reviewing.supersedeAssumption({
        ...replayWithoutRevision,
        payload: { ...supersedeInput.payload, text: "Conflicting retry" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "idempotency_conflict" },
    });

    await expect(
      reviewing.supersedeAssumption({
        ...supersedeInput,
        draftRevisionId: "revision-missing",
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "idempotency_conflict" },
    });

    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T16:30:00.000Z",
    });
    await specs.createDraftFromBase({
      id: "revision-replacement",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "design",
      createdAt: "2026-07-18T16:45:00.000Z",
    });
    await expect(
      reviewing.supersedeAssumption({
        ...supersedeInput,
        draftRevisionId: "revision-replacement",
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "idempotency_conflict" },
    });
    await expect(
      reviewing.supersedeAssumption(replayWithoutRevision),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        successor: { handle: "A2" },
        newRecordVersion: 4,
        newCitationVersion: 6,
        idempotentReplay: true,
      },
    });
    await expect(
      reviewing.supersedeAssumption({
        ...replayWithoutRevision,
        payload: {
          ...supersedeInput.payload,
          operationId: "different-supersession-operation",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "attention_state_conflict" },
    });

    await specs.abandon({
      specId: created.spec.id,
      abandonedAt: "2026-07-18T17:00:00.000Z",
      reason: "The product direction changed.",
      updatedAt: "2026-07-18T17:00:00.000Z",
    });
    await expect(
      reviewing.supersedeAssumption(replayWithoutRevision),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        successor: { handle: "A2" },
        newRecordVersion: 4,
        newCitationVersion: 6,
        idempotentReplay: true,
      },
    });
    await expect(
      reviewing.supersedeAssumption({
        ...replayWithoutRevision,
        payload: { ...supersedeInput.payload, text: "Conflicting retry" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "idempotency_conflict" },
    });
  });

  it("requires a writable draft for a first supersession operation", async () => {
    const created = await createPopulatedSpec();
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: null,
      text: "The validator is deterministic.",
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");
    await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      recordVersion: 1,
      disposition: "confirmed",
      actor: HUMAN,
    });
    await specs.approveRevision({
      revisionId: created.draft.id,
      approvedAt: "2026-07-18T16:00:00.000Z",
    });
    expect(await specs.findDraft(created.spec.id)).toBeNull();

    await expect(
      reviewing.supersedeAssumption({
        specId: created.spec.id,
        assumptionId: proposed.value.id,
        expectedRecordVersion: 2,
        expectedCitationVersion: 1,
        payload: {
          operationId: "first-supersession-without-draft",
          reason: "The premise needs correction.",
          text: "The validator is deterministic under a pinned revision.",
          attachment: { kind: "spec" },
          citations: { kind: "clear" },
        },
        actor: LATER_AGENT,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "amendment_required" },
    });
  });

  it("requires citation CAS before preserving a cited assumption across attachment edits", async () => {
    const created = await createPopulatedSpec();
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "requirement-1",
      text: "The validator is deterministic.",
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("assumption should be proposed");

    const edit = {
      specId: created.spec.id,
      recordId: proposed.value.id,
      expectedRecordVersion: 1,
      payload: {
        kind: "assumption" as const,
        attachment: { kind: "element" as const, handle: "D1" },
        citationIntent: { kind: "preserve" as const },
      },
      actor: LATER_AGENT,
    };
    await expect(reviewing.editAttentionRecord(edit)).resolves.toMatchObject({
      ok: false,
      refusal: { code: "stale_citation_set" },
    });
    await expect(
      reviewing.editAttentionRecord({
        ...edit,
        expectedCitationVersion: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "stale_citation_set" },
    });
    expect(reviewRepo.findAssumptionById(proposed.value.id)).toMatchObject({
      record_version: 1,
      element_id: "requirement-1",
    });

    await expect(
      reviewing.editAttentionRecord({
        ...edit,
        expectedCitationVersion: 2,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        previousRecordVersion: 1,
        newRecordVersion: 2,
        previousCitationVersion: 2,
        newCitationVersion: 3,
        citationChanges: { refreshed: ["R1"] },
      },
    });
    expect(reviewRepo.findAssumptionById(proposed.value.id)).toMatchObject({
      record_version: 2,
      element_id: "decision-1",
    });
  });
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
      recordVersion: opened.value.record_version,
      answer: "The deterministic integration suite.",
      actor: HUMAN,
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

  it("supports one human disposition and refuses terminal rewrites", async () => {
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
      recordVersion: proposed.value.record_version,
      citationVersion: 2,
      disposition: "confirmed",
      actor: HUMAN,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      value: { disposition: "confirmed" },
    });

    await expect(
      authoring.proposeRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, revision: { state: "draft" } });
    await expect(
      approveAndSignOff(created.spec.id, created.draft.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const changed = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      recordVersion: 2,
      citationVersion: 3,
      disposition: "rejected",
      actor: HUMAN,
    });
    expect(changed).toMatchObject({
      ok: false,
      refusal: { code: "attention_state_conflict" },
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

    const rejected = await reviewing.disposeAssumption({
      specId: created.spec.id,
      assumptionId: proposed.value.id,
      recordVersion: proposed.value.record_version,
      citationVersion: 2,
      disposition: "rejected",
      actor: HUMAN,
    });
    expect(rejected).toMatchObject({
      ok: true,
      value: { disposition: "rejected" },
    });

    await expect(
      authoring.proposeRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, revision: { state: "draft" } });

    const signOff = await approveAndSignOff(created.spec.id, created.draft.id);
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
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
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
        recordVersion: proposed.value.record_version,
        disposition,
        actor: HUMAN,
      });
      expect(disposed).toMatchObject({ ok: true, value: { disposition } });
    }
  });

  it("requires a draft for attached post-approval assumptions without backfilling frozen truth", async () => {
    const created = await createPopulatedSpec();
    await expect(
      authoring.proposeRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, revision: { state: "draft" } });
    await expect(
      approveAndSignOff(created.spec.id, created.draft.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const refused = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "decision-1",
      text: "This assumption was created after the approved snapshot froze.",
      actor: AGENT,
    });
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: "amendment_required" },
    });
    const { revision: amendment } = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    const proposed = await reviewing.proposeAssumption({
      specId: created.spec.id,
      elementId: "decision-1",
      text: "This assumption belongs only to the amendment.",
      actor: AGENT,
    });
    expect(proposed).toMatchObject({ ok: true });
    expect(await specs.readRevisionCitations(created.draft.id)).toEqual([]);
    expect(await specs.readRevisionCitations(amendment.id)).toEqual([
      expect.objectContaining({
        assumptionId: proposed.ok ? proposed.value.id : "unreachable",
        elementId: "decision-1",
      }),
    ]);
  });

  it("applies a hard-confirmed human policy change prospectively without creating approvals", async () => {
    const created = await createPopulatedSpec();
    const existing = await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      approver: "alex",
      expectedReviewHash: await reviewHash(created.draft.id),
      actor: HUMAN,
    });
    if (!existing.ok) throw new Error(existing.refusal.code);
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
      expect.objectContaining({ id: existing.value.id, validity: "valid" }),
    ]);
    expect(reviewRepo.findGateAdmissionsByRevision(created.draft.id)).toEqual(
      [],
    );
  });
});
