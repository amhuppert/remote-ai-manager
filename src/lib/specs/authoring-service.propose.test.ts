import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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

const PROJECT_PATH = "/repos/native-sdd-propose";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;

let db: Db;
let specs: SpecsRepo;
let review: SpecReviewRepo;
let service: AuthoringService;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  review = createSpecReviewRepo(db);
  const eventRows = createSpecEventsRepo(db);
  idSequence = 0;
  timeSequence = 0;
  service = createAuthoringService({
    specs,
    review,
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: eventRows.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-18T13:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => db.close());

async function createSpec(
  preset: "contract-bearing" | "exploratory" | "fast-path",
  statement = "The transition is server-enforced.",
) {
  // The first requirement travels inside the create call — the durable spec
  // is born from its first draft save.
  const created = await service.createSpec({
    projectPath: PROJECT_PATH,
    slug: `spec-${preset}`,
    name: `Spec ${preset}`,
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement,
        priority: "must",
        risk: "high",
      },
    },
    actor: ACTOR,
  });
  await specs.updateGatePolicy({
    specId: created.spec.id,
    gatePolicy: { preset },
    updatedAt: "2026-07-18T13:00:00.500Z",
  });
  return created;
}

async function addCleanContent(specId: string, revisionId: string) {
  await service.upsertDraftElement({
    specId,
    revisionId,
    elementId: "criterion-1",
    kind: "criterion",
    parentElementId: "requirement-1",
    position: 1,
    payload: {
      kind: "criterion",
      text: "An invalid transition is refused.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: ACTOR,
  });
  await service.upsertDraftElement({
    specId,
    revisionId,
    elementId: "task-1",
    kind: "task",
    parentElementId: null,
    position: 2,
    payload: {
      kind: "task",
      title: "Implement transition",
      instructions: "Implement the server predicate.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-1"],
      dependsOnTaskElementIds: [],
    },
    baseElementVersion: null,
    actor: ACTOR,
  });
}

describe("AuthoringService propose transaction", () => {
  it("freezes, hashes, and classifies a clean draft while a gate dial leaves it Proposed", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: {
        id: created.draft.id,
        state: "proposed",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.diff.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elementId: "requirement-1",
          classification: "modified",
        }),
        expect.objectContaining({
          elementId: "criterion-1",
          classification: "modified",
        }),
        expect.objectContaining({
          elementId: "task-1",
          classification: "modified",
        }),
      ]),
    );
    expect(await specs.verifyRevision(created.draft.id)).toMatchObject({
      ok: true,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions").get(),
    ).toEqual({ count: 0 });
  });

  /**
   * The receipt carries the server's post-transition projection because a
   * blocker derived from the revision's authoring stage alone names the wrong
   * gate whenever an earlier stage is also consulted, and cannot name the
   * subject a request needs.
   */
  it("embeds the post-transition pending block naming every consulted gate and its outstanding subjects", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    // The draft is pinned at the plan stage, but its requirement is new since
    // the governance baseline, so requirements is consulted too — and it is
    // what a human acts on first.
    expect(result.pendingBlock?.gates).toEqual([
      {
        gate: "requirements",
        dial: "gate",
        state: "pending",
        applicability: {
          reason: "changed_since_governance_base",
          governanceBaseRevisionId: null,
        },
        subjects: ["R1"],
      },
      {
        gate: "plan",
        dial: "gate",
        state: "pending",
        applicability: {
          reason: "current_stage",
          governanceBaseRevisionId: null,
        },
        subjects: ["plan"],
      },
    ]);
    expect(result.pendingBlock?.outstandingSubjects).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
      { gate: "plan", subject: "plan", elementId: null },
    ]);
    expect(result.pendingBlock?.signOff).toMatchObject({
      revisionId: created.draft.id,
      state: "blocked",
      outstandingSubjectCount: 2,
    });
    expect(result.pendingBlock?.actsNext).toBe("human");
    // The subject a request needs is in the block, so the caller never has to
    // guess it from the stage.
    expect(result.pendingBlock?.instruction).toContain("R1");
    expect(result.nextAction).toMatchObject({
      kind: "approve_subject",
      gate: "requirements",
      subject: "R1",
    });
  });

  /**
   * R11.5: the combined dial makes the sign-off itself the approval of every
   * item. A receipt that lists the items as outstanding subjects points the
   * caller at `request-approval` for an act the policy collapsed, and at the
   * same time reports the revision ready to sign off.
   */
  it("names the sign-off rather than per-item approvals under the combined dial", async () => {
    const created = await createSpec("fast-path");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.pendingBlock?.outstandingSubjects).toEqual([]);
    expect(result.pendingBlock?.signOff).toMatchObject({
      state: "ready",
      unmetConditions: [],
    });
    expect(result.pendingBlock?.actsNext).toBe("human");
    expect(result.nextAction).toMatchObject({
      kind: "sign_off_revision",
      actsNext: "human",
      gate: null,
      subject: null,
    });
  });

  it("carries sign-off conditions that no subject approval can clear", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    review.saveAssumption({
      id: "assumption-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: "requirement-1",
      text: "The baseline never moves.",
      proposed_by_json: JSON.stringify(ACTOR),
      disposition: "rejected",
      disposed_at: "2026-07-18T13:00:00.900Z",
      created_at: "2026-07-18T13:00:00.900Z",
      updated_at: "2026-07-18T13:00:00.900Z",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.pendingBlock?.unmetConditions).toContain(
      "A1 was rejected but R1 still cites it.",
    );
  });

  it("returns exactly the panel findings and leaves a lint-refused revision Draft", async () => {
    const created = await createSpec("contract-bearing", "Incomplete.");
    review.saveQuestion({
      id: "question-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: null,
      text: "Which advisory remains open?",
      provenance_json: JSON.stringify(ACTOR),
      status: "open",
      answer: null,
      answered_at: null,
      created_at: "2026-07-18T13:10:00.000Z",
      updated_at: "2026-07-18T13:10:00.000Z",
    });
    const panel = await service.lintDraft(created.spec.id, created.draft.id);
    expect(panel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "blocks_propose" }),
        expect.objectContaining({ severity: "advisory" }),
      ]),
    );

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "lint_blocked",
        findings: panel,
      }),
    });
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
    expect(
      (await specs.findRevision(created.draft.id))?.contentHash,
    ).toBeNull();
  });

  it("refuses a plan containing a task that covers no criterion", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-2",
      kind: "task",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task",
        title: "Prepare implementation",
        instructions: "Prepare the implementation surface.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });

    const panel = await service.lintDraft(created.spec.id, created.draft.id);
    expect(panel).toContainEqual({
      ruleId: "9.3.task-without-criterion",
      severity: "blocks_propose",
      elementHandle: "T2",
      message: "T2 covers no acceptance criterion.",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "lint_blocked",
        findings: panel,
      }),
    });
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
  });

  it("absorbs all Notify/Off propose gates into policy sign-off with admissions and zero approvals", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toMatchObject({
      ok: true,
      absorbedSignOff: true,
      revision: { state: "approved" },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_approvals").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "SELECT gate, basis FROM spec_gate_admissions ORDER BY gate ASC",
        )
        .all(),
    ).toEqual([
      { gate: "plan", basis: "notify_policy" },
      { gate: "requirements", basis: "notify_policy" },
    ]);
  });

  it("commits Proposed but surfaces a failed absorbed-sign-off precondition", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);
    review.saveComment({
      id: "comment-1",
      spec_id: created.spec.id,
      thread_id: "thread-1",
      parent_comment_id: null,
      element_id: "requirement-1",
      anchor_json: "{}",
      revision_id: created.draft.id,
      body: "Resolve this before sign-off.",
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 1,
      resolution: "open",
      created_at: "2026-07-18T13:20:00.000Z",
      updated_at: "2026-07-18T13:20:00.000Z",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "gate_blocked",
        unmetConditions: ["Blocking thread thread-1 is unresolved."],
      }),
    });
    expect((await specs.findRevision(created.draft.id))?.state).toBe(
      "proposed",
    );
    expect((await specs.findRevision(created.draft.id))?.contentHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("carries unchanged approvals and marks directly modified or removed subjects stale or closed", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "decision",
        title: "Transition ownership",
        chosenApproach: "The server owns transitions.",
        rejectedAlternatives: [],
        reason: "The gate cannot depend on prompt etiquette.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
    const initial = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });
    if (!initial.ok) throw new Error("initial revision should be approved");

    for (const approval of [
      {
        id: "approval-requirement",
        subject_kind: "requirement" as const,
        element_id: "requirement-1",
      },
      {
        id: "approval-decision",
        subject_kind: "decision" as const,
        element_id: "decision-1",
      },
      {
        id: "approval-plan",
        subject_kind: "plan" as const,
        element_id: null,
      },
    ]) {
      review.saveApproval({
        ...approval,
        spec_id: created.spec.id,
        revision_id: created.draft.id,
        approver: "alex",
        granted_at: "2026-07-18T13:30:00.000Z",
        validity: "valid",
      });
    }

    const { revision: amendment } = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "The transition and refusal are server-enforced.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: 1,
      actor: ACTOR,
    });
    await service.removeDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "decision-1",
      baseElementVersion: 1,
      actor: ACTOR,
    });

    const proposed = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      actor: ACTOR,
    });
    expect(proposed.ok).toBe(true);
    expect(
      review
        .findApprovalsBySpecId(created.spec.id)
        .map(({ id, validity }) => ({ id, validity })),
    ).toEqual([
      { id: "approval-decision", validity: "closed" },
      { id: "approval-plan", validity: "valid" },
      { id: "approval-requirement", validity: "stale" },
    ]);
  });

  it("refuses proposing a non-draft revision", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    const repeated = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });
    expect(repeated).toEqual({
      ok: false,
      refusal: expect.objectContaining({ code: "gate_blocked" }),
    });
  });
});
