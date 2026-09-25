import { beforeEach, describe, expect, it, vi } from "vitest";

const logging = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logging.warn,
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  serializeSubjectFingerprint,
  subjectFingerprint,
  type SubjectFingerprint,
} from "./approval-applicability";
import { createSpecEventsPublisher } from "./events";
import {
  createReviewService,
  type ReviewService,
  type ReviewServiceDeps,
  type SpecApprovalRequestNotice,
} from "./review-service";
import { revisionReviewHash } from "./review-hash";
import { toDiffCitations, toDiffRows } from "./revision-diff-projections";
import type { SpecRevisionSnapshot } from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/approval-requests";
const SPEC_ID = "spec-approval-requests";
const DRAFT_REVISION_ID = "revision-draft";
const APPROVED_REVISION_ID = "revision-approved";
const REQUIREMENT_ELEMENT_ID = "element-requirement-1";
const DECISION_ELEMENT_ID = "element-decision-1";
const EXECUTION_ID = "spec-execution-1";
const SECOND_EXECUTION_ID = "spec-execution-2";
const NOW = "2026-07-25T09:00:00.000Z";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;

describe("ReviewService.requestApproval validation", () => {
  let db: Db;
  let service: ReviewService;
  let specs: ReturnType<typeof createSpecsRepo>;
  let eventsRepo: ReturnType<typeof createSpecEventsRepo>;
  let reviewRepo: ReturnType<typeof createSpecReviewRepo>;
  let published: SSEEvent[];
  let requested: SpecApprovalRequestNotice[];
  let serviceDeps: ReviewServiceDeps;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    published = [];
    requested = [];
    logging.warn.mockClear();
    let idSequence = 0;
    specs = createSpecsRepo(db, createWriteQueue());
    reviewRepo = createSpecReviewRepo(db);
    eventsRepo = createSpecEventsRepo(db);
    serviceDeps = {
      specs,
      review: reviewRepo,
      delivery: createSpecDeliveryRepo(db),
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish(event) {
          published.push(event);
          return { delivered: true };
        },
      }),
      attention: eventsRepo,
      notifier: {
        approvalRequested(notice) {
          requested.push(notice);
        },
        approvalGranted() {},
        approvalRequestsClosed() {},
      },
      newId: (prefix) => `${prefix}-${++idSequence}`,
      now: () => NOW,
    };
    service = createReviewService(serviceDeps);
  });

  /** The fields of one warn the service emitted under `event`. */
  function warnFields(event: string): Record<string, unknown> {
    const calls = logging.warn.mock.calls.filter(
      ([name]: unknown[]) => name === event,
    );
    if (calls.length !== 1) {
      throw new Error(`expected one ${event} warn, saw ${calls.length}`);
    }
    const fields: unknown = calls[0]?.[1];
    if (typeof fields !== "object" || fields === null) {
      throw new Error(`${event} carried no structured fields`);
    }
    return fields as Record<string, unknown>;
  }

  function attentionEvents() {
    return eventsRepo
      .findBySpecId(SPEC_ID)
      .filter((event) => event.event_type === "spec-attention-changed");
  }

  async function snapshotOf(revisionId: string): Promise<SpecRevisionSnapshot> {
    const snapshot = await specs.getRevisionSnapshot(revisionId);
    if (snapshot === null) throw new Error(`no snapshot for ${revisionId}`);
    return snapshot;
  }

  /** The requirement's subject exactly as a human reading `snapshot` sees it. */
  function requirementFingerprint(
    snapshot: SpecRevisionSnapshot,
  ): SubjectFingerprint {
    const fingerprint = subjectFingerprint(
      toDiffRows(snapshot),
      { subjectKind: "requirement", elementId: REQUIREMENT_ELEMENT_ID },
      {
        citationContractVersion: snapshot.revision.citationContractVersion,
        citations: toDiffCitations(snapshot),
      },
    );
    if (fingerprint === null) {
      throw new Error(`${snapshot.revision.id} carries no requirement`);
    }
    return fingerprint;
  }

  function approveRequirementOnDraft(reviewHash: string) {
    return service.approveItem({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      subjectKind: "requirement",
      elementId: REQUIREMENT_ELEMENT_ID,
      approver: "operator",
      actor: { kind: "human" },
      expectedReviewHash: reviewHash,
    });
  }

  /**
   * The open draft is what a human reviews, so an ask filed against it has an
   * exit: the human's approval on that same draft answers it. An ask no act
   * could clear is what request validation exists to prevent.
   */
  it("files an authoring request on the open draft that a human approval on the draft answers", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    if (!result.ok) throw new Error("the draft request was refused");
    expect(result.value).toMatchObject({
      revisionId: DRAFT_REVISION_ID,
      scope: "item",
      subject: "R1",
    });
    expect(eventsRepo.listOpenApprovalRequests(SPEC_ID)).toHaveLength(1);

    const approved = await approveRequirementOnDraft(
      revisionReviewHash(await snapshotOf(DRAFT_REVISION_ID)),
    );

    expect(approved.ok).toBe(true);
    expect(eventsRepo.listOpenApprovalRequests(SPEC_ID)).toEqual([]);
  });

  it("issues the request for an outstanding element approval", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        gate: "requirements",
        subject: "R1",
        deliveryOutcome: "delivered",
      },
    });
    expect(attentionEvents()).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  /**
   * The notifier runs after the request has durably committed, so a throw
   * there cannot un-ask the question — propagating it would turn a successful
   * act into a 5xx and teach agents to retry an ask that already landed.
   */
  it("keeps a committed request successful when the notifier throws, reporting delivery as uncertain", async () => {
    const crashing = createReviewService({
      ...serviceDeps,
      notifier: {
        approvalRequested() {
          throw new Error("notification pipeline down");
        },
        approvalGranted() {},
        approvalRequestsClosed() {},
      },
    });

    const result = await crashing.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      // The durable ask exists; only the human-facing row may be missing, and
      // the receipt says which of the two the caller is looking at.
      value: {
        attentionId: "attention-1",
        deliveryOutcome: "delivery-uncertain",
      },
    });
    expect(attentionEvents()).toHaveLength(1);
    const fields = warnFields("specs.review.approval_request_notify_failed");
    expect(fields).toMatchObject({
      specId: SPEC_ID,
      attentionId: "attention-1",
      gate: "requirements",
    });
    // Ids only: a notice carries the spec name and the human-facing message.
    expect(fields).not.toHaveProperty("subject");
    expect(fields).not.toHaveProperty("specName");
  });

  /**
   * Retiring a pre-scope ask is bookkeeping the requester did not ask for.
   * Its notice failing must not cost the requester the act it did ask for.
   */
  it("keeps the request successful when the retirement notice fails to deliver", async () => {
    seedPreBoundaryRequest("R1");
    const crashing = createReviewService({
      ...serviceDeps,
      notifier: {
        approvalRequested(notice) {
          requested.push(notice);
        },
        approvalGranted() {},
        approvalRequestsClosed() {
          throw new Error("notification pipeline down");
        },
      },
    });

    const result = await crashing.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    // The closing notice runs first, so an unguarded throw would also cost
    // the request its own notice: both must survive.
    expect(result).toMatchObject({
      ok: true,
      value: { alreadyRequested: false, deliveryOutcome: "delivered" },
    });
    expect(requested).toHaveLength(1);
    expect(
      warnFields("specs.review.approval_requests_closed_notify_failed"),
    ).toMatchObject({
      specId: SPEC_ID,
      attentionIds: ["attention-pre-boundary-R1"],
    });
  });

  /** One approval request as it was recorded before requests carried a scope. */
  function seedPreBoundaryRequest(subject: string): void {
    eventsRepo.append({
      spec_id: SPEC_ID,
      occurred_at: NOW,
      event_type: "spec-attention-changed",
      actor_json: JSON.stringify(AGENT),
      payload_json: JSON.stringify({
        kind: "approval-requested",
        attentionId: `attention-pre-boundary-${subject}`,
        revisionId: DRAFT_REVISION_ID,
        gate: "requirements",
        subject,
        executionId: null,
        active: true,
      }),
    });
  }

  it("returns the existing request instead of a second Needs You entry", async () => {
    const first = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    const second = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    if (!first.ok || !second.ok) throw new Error("request was refused");
    expect(second.value.attentionId).toBe(first.value.attentionId);
    expect(second.value.alreadyRequested).toBe(true);
    expect(first.value.alreadyRequested).toBe(false);
    expect(attentionEvents()).toHaveLength(1);
    // The repeat re-invokes the notifier as an idempotent ensure (it dedupes
    // on the stable attention id), so a notifier crash on the first attempt
    // can never permanently lose the Needs You row.
    expect(requested).toHaveLength(2);
    expect(new Set(requested.map((notice) => notice.gateRequestId)).size).toBe(
      1,
    );
  });

  it("converges the gate's pinned-revision ask and the CLI's latest-revision ask on one durable request", async () => {
    // The delivery gate auto-fire names the run's pinned revision while the
    // CLI resolves the latest one; with an open amendment those differ. A
    // per-run gate's identity is (spec, gate, subject, execution), so both
    // asks must land on the same durable request and attention id.
    const fromCli = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });
    const fromGate = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    if (!fromCli.ok || !fromGate.ok) throw new Error("request was refused");
    expect(fromGate.value.attentionId).toBe(fromCli.value.attentionId);
    expect(fromGate.value.alreadyRequested).toBe(true);
    expect(fromCli.value.alreadyRequested).toBe(false);
    const events = attentionEvents();
    expect(events).toHaveLength(1);
    // The durable identity is canonicalized to the revision the run pinned —
    // the only revision this run can ever be approved against.
    const payload: unknown = JSON.parse(events[0]?.payload_json ?? "null");
    expect(payload).toMatchObject({
      kind: "approval-requested",
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      executionId: EXECUTION_ID,
    });
    expect(fromCli.value.revisionId).toBe(APPROVED_REVISION_ID);
  });

  it("recognizes a pre-fix execution-scoped request persisted under a non-pinned revision", async () => {
    // Rows persisted before revision canonicalization can carry the latest
    // revision in their payload; the execution id alone identifies the ask.
    eventsRepo.append({
      spec_id: SPEC_ID,
      occurred_at: NOW,
      event_type: "spec-attention-changed",
      actor_json: JSON.stringify(AGENT),
      payload_json: JSON.stringify({
        kind: "approval-requested",
        attentionId: "attention-pre-fix",
        revisionId: DRAFT_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        executionId: EXECUTION_ID,
        active: true,
      }),
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    if (!result.ok) throw new Error("request was refused");
    expect(result.value.attentionId).toBe("attention-pre-fix");
    expect(result.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
  });

  /**
   * A withdrawn revision is terminal: `approveItem` refuses on it, so a
   * request against it is a Needs You entry no human act can ever clear. The
   * spec moves by amendment, not by approval.
   */
  it("refuses an element request against a withdrawn revision", async () => {
    const withdrawn = await service.withdraw({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      actor: { kind: "human" },
    });
    expect(withdrawn.ok).toBe(true);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "gate_not_applicable",
        unmetConditions: [
          `Revision ${DRAFT_REVISION_ID} was withdrawn, so no approval can be recorded against it.`,
        ],
      },
    });
    expect(attentionEvents()).toHaveLength(0);
    expect(requested).toHaveLength(0);
  });

  it("asks again for the next run at an execution-scoped gate, and only once per run", async () => {
    const requestDelivery = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        actor: AGENT,
      });

    const firstRun = await requestDelivery();
    const firstRunRepeat = await requestDelivery();
    if (!firstRun.ok || !firstRunRepeat.ok) {
      throw new Error("request was refused");
    }
    expect(firstRunRepeat.value.attentionId).toBe(firstRun.value.attentionId);
    expect(firstRunRepeat.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
    // Repeat notices reuse the run's attention id (idempotent ensure).
    expect(requested.map((notice) => notice.gateRequestId)).toEqual([
      firstRun.value.attentionId,
      firstRun.value.attentionId,
    ]);

    startSecondRun(db);

    const secondRun = await requestDelivery();
    if (!secondRun.ok) throw new Error("request was refused");
    expect(secondRun.value.alreadyRequested).toBe(false);
    expect(secondRun.value.attentionId).not.toBe(firstRun.value.attentionId);
    expect(attentionEvents()).toHaveLength(2);
    expect(requested).toHaveLength(3);
  });

  it("keeps a revision-scoped request idempotent across runs, which do not scope it", async () => {
    const requestRequirements = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "requirements",
        subject: "R1",
        actor: AGENT,
      });

    const first = await requestRequirements();
    startSecondRun(db);
    const second = await requestRequirements();

    if (!first.ok || !second.ok) throw new Error("request was refused");
    expect(second.value.attentionId).toBe(first.value.attentionId);
    expect(second.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
    expect(new Set(requested.map((notice) => notice.gateRequestId)).size).toBe(
      1,
    );
  });

  it("refuses a request that names a revision other than the current one", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "stale_revision" },
    });
    expect(attentionEvents()).toHaveLength(0);
    expect(requested).toHaveLength(0);
  });

  it("refuses a gate the policy does not gate on", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"requirements":"notify"}}',
      SPEC_ID,
    );

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  /**
   * The gate's dial still says `gate`, so "the policy asks for no approval" is
   * the wrong answer and "nothing is outstanding" hides why. What decides it is
   * the governance baseline: the draft changed nothing this gate governs since
   * the last approved revision, so it is not consulted at all.
   */
  it("refuses a gate whose content is unchanged since the governance baseline, naming that baseline", async () => {
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(DRAFT_REVISION_ID);
    db.prepare(
      `UPDATE spec_element_versions
         SET payload_json = (
           SELECT payload_json FROM spec_element_versions
            WHERE revision_id = ? AND element_id = ?
         ),
         payload_hash = (
           SELECT payload_hash FROM spec_element_versions
            WHERE revision_id = ? AND element_id = ?
         )
       WHERE revision_id = ? AND element_id = ?`,
    ).run(
      APPROVED_REVISION_ID,
      REQUIREMENT_ELEMENT_ID,
      APPROVED_REVISION_ID,
      REQUIREMENT_ELEMENT_ID,
      DRAFT_REVISION_ID,
      REQUIREMENT_ELEMENT_ID,
    );

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.unmetConditions).toEqual([
      `The requirements gate is not consulted for revision ${DRAFT_REVISION_ID}: nothing it governs changed since revision ${APPROVED_REVISION_ID}.`,
    ]);
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses a gate the draft has not reached yet", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "plan",
      subject: "plan",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  /**
   * The one outstanding subject is NOT what an omitted subject means. If it
   * were, the same command would ask for a different thing tomorrow, and the
   * request's durable identity would move under the human reading it.
   */
  it("asks for the gate itself when the subject is omitted, even at one outstanding subject", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        gate: "requirements",
        scope: "gate",
        subject: "requirements",
        outstandingSubjects: ["R1"],
      },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("asks for the gate itself with several subjects outstanding, naming them in the receipt", async () => {
    insertElement(db, "element-requirement-2", "requirement", 2, null);
    insertVersion(db, DRAFT_REVISION_ID, "element-requirement-2", 2, {
      kind: "requirement",
      statement: "A second outstanding requirement.",
      priority: "must",
      risk: "low",
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: "gate",
        subject: "requirements",
        outstandingSubjects: ["R1", "R2"],
      },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("resolves an omitted subject at an execution gate to the gate itself", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "delivery", subject: "delivery" },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("refuses a delivery request while no run exists to approve", async () => {
    db.prepare("DELETE FROM spec_executions WHERE id = ?").run(EXECUTION_ID);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses an execution-start request while no run awaits definition approval", async () => {
    // The seeded run is already running: its start either happened or was
    // policy-admitted, so there is no definition left for a human to approve.
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("issues the execution-start request for a run parked with its lane linked", async () => {
    db.prepare(
      "UPDATE spec_executions SET state = 'definition_review', workflow_execution_id = 'workflow-execution-1' WHERE id = ?",
    ).run(EXECUTION_ID);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "execution_start", subject: "execution_start" },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("issues the frozen execution-start request after the live dial changes to Notify", async () => {
    db.prepare(
      "UPDATE spec_executions SET state = 'definition_review', workflow_execution_id = 'workflow-execution-1' WHERE id = ?",
    ).run(EXECUTION_ID);
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"execution_start":"notify"}}',
      SPEC_ID,
    );

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "execution_start", subject: "execution_start" },
    });
    expect(attentionEvents()).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  it("refuses a subject that is not outstanding at the named gate", async () => {
    const unknown = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R9",
      actor: AGENT,
    });
    const wrongGate = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "D1",
      actor: AGENT,
    });

    expect(unknown).toMatchObject({
      ok: false,
      refusal: { code: "invalid_subject" },
    });
    expect(wrongGate).toMatchObject({
      ok: false,
      refusal: { code: "invalid_subject" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses a request for an approval that is already granted", async () => {
    const approved = await approveRequirementOnDraft(
      revisionReviewHash(await snapshotOf(DRAFT_REVISION_ID)),
    );
    expect(approved.ok).toBe(true);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  /**
   * The author keeps editing the draft a human is reviewing, so an approval
   * covers the subject as it was read, not the draft row it names. Editing
   * something else leaves it standing; editing the subject reopens it.
   */
  it("requests an approved subject again once the draft edits it, never after an unrelated edit", async () => {
    const approved = await approveRequirementOnDraft(
      revisionReviewHash(await snapshotOf(DRAFT_REVISION_ID)),
    );
    expect(approved.ok).toBe(true);
    const requestRequirement = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "requirements",
        subject: "R1",
        actor: AGENT,
      });

    editDraftElement(db, DECISION_ELEMENT_ID, {
      kind: "decision",
      title: "Validate before notifying, restated",
      chosenApproach: "Derive the requestable set from the status projection.",
      rejectedAlternatives: [],
      reason:
        "A duplicate Needs You entry teaches agents to distrust the queue.",
      tracedRequirementElementIds: [],
    });
    await expect(requestRequirement()).resolves.toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });

    editDraftElement(db, REQUIREMENT_ELEMENT_ID, {
      kind: "requirement",
      statement: "The surface refuses every request it cannot satisfy.",
      priority: "must",
      risk: "high",
    });
    await expect(requestRequirement()).resolves.toMatchObject({
      ok: true,
      value: { scope: "item", subject: "R1", alreadyRequested: false },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  /**
   * An approval names the revision whose content a human read. A revision the
   * draft does not descend from is a different line of content, so its
   * approval cannot make this subject stop asking — even when the two revisions
   * happen to carry byte-identical text.
   */
  it("still requests a subject whose only approval sits on a revision outside the draft's lineage", async () => {
    const siblingRevisionId = "revision-sibling";
    db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, authoring_stage, based_on_revision_id,
         content_hash, proposed_at, approved_at, created_at
       ) VALUES (?, ?, 3, 'withdrawn', 'requirements', ?, 'hash-3', ?, NULL, ?)`,
    ).run(siblingRevisionId, SPEC_ID, APPROVED_REVISION_ID, NOW, NOW);
    // The draft stays the spec's current revision; the sibling is an earlier
    // attempt off the same approved base.
    db.prepare("UPDATE spec_revisions SET number = 4 WHERE id = ?").run(
      DRAFT_REVISION_ID,
    );
    // Byte-identical content, down to the payload hash, so nothing but the
    // sibling's absence from the draft's lineage can refuse its approval.
    db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       )
       SELECT ?, element_id, position, payload_json, payload_hash,
              element_version, created_at, updated_at
       FROM spec_element_versions
       WHERE revision_id = ? AND element_id = ?`,
    ).run(siblingRevisionId, DRAFT_REVISION_ID, REQUIREMENT_ELEMENT_ID);
    const approvedSubject = requirementFingerprint(
      await snapshotOf(siblingRevisionId),
    );
    expect(approvedSubject).toEqual(
      requirementFingerprint(await snapshotOf(DRAFT_REVISION_ID)),
    );
    reviewRepo.saveApproval({
      id: "approval-requirement-sibling",
      spec_id: SPEC_ID,
      subject_kind: "requirement",
      element_id: REQUIREMENT_ELEMENT_ID,
      revision_id: siblingRevisionId,
      approver: "operator",
      granted_at: NOW,
      validity: "valid",
      subject_fingerprint_json: serializeSubjectFingerprint(approvedSubject),
    });

    await expect(
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "requirements",
        subject: "R1",
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, value: { subject: "R1" } });
  });

  it("refuses a delivery request while the gate is already admitted for the run", async () => {
    reviewRepo.insertGateAdmission({
      id: "admission-delivery-1",
      spec_id: SPEC_ID,
      gate: "delivery",
      basis: "human_approval",
      approval_id: null,
      revision_id: APPROVED_REVISION_ID,
      execution_id: EXECUTION_ID,
      actor_json: '{"kind":"human"}',
      created_at: NOW,
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("still issues the delivery request while the run holds no admission", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({ ok: true, value: { gate: "delivery" } });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("names the spec, not approval authority: the receipt never records an admission", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result.ok).toBe(true);
    expect(reviewRepo.findGateAdmissionsBySpecId(SPEC_ID)).toHaveLength(0);
    expect(reviewRepo.findApprovalsBySpecId(SPEC_ID)).toHaveLength(0);
  });
});

function seed(db: Db): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "approval-requests",
    "Approval Requests",
    '{"preset":"contract-bearing"}',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, 'hash-1', ?, ?, ?)`,
  ).run(APPROVED_REVISION_ID, SPEC_ID, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, 2, 'draft', 'requirements', ?, NULL, NULL, NULL, ?)`,
  ).run(DRAFT_REVISION_ID, SPEC_ID, APPROVED_REVISION_ID, NOW);
  insertElement(db, REQUIREMENT_ELEMENT_ID, "requirement", 1, null);
  insertVersion(db, APPROVED_REVISION_ID, REQUIREMENT_ELEMENT_ID, 0, {
    kind: "requirement",
    statement: "The surface refuses a request it cannot satisfy.",
    priority: "must",
    risk: "high",
  });
  insertVersion(db, DRAFT_REVISION_ID, REQUIREMENT_ELEMENT_ID, 0, {
    kind: "requirement",
    statement: "The surface refuses a request it cannot satisfy, restated.",
    priority: "must",
    risk: "high",
  });
  insertElement(db, DECISION_ELEMENT_ID, "decision", 1, null);
  insertVersion(db, DRAFT_REVISION_ID, DECISION_ELEMENT_ID, 1, {
    kind: "decision",
    title: "Validate before notifying",
    chosenApproach: "Derive the requestable set from the status projection.",
    rejectedAlternatives: [],
    reason: "A duplicate Needs You entry teaches agents to distrust the queue.",
    tracedRequirementElementIds: [],
  });
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
       NULL, NULL, ?, ?)`,
  ).run(
    EXECUTION_ID,
    SPEC_ID,
    APPROVED_REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    NOW,
    NOW,
  );
}

/**
 * The seeded run ends and a fresh one starts against the same approved
 * revision — the shape that made a per-run gate look already-requested.
 */
function startSecondRun(db: Db): void {
  db.prepare("UPDATE spec_executions SET state = 'delivered' WHERE id = ?").run(
    EXECUTION_ID,
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
       NULL, NULL, ?, ?)`,
  ).run(
    SECOND_EXECUTION_ID,
    SPEC_ID,
    APPROVED_REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    "2026-07-25T10:00:00.000Z",
    "2026-07-25T10:00:00.000Z",
  );
}

function insertElement(
  db: Db,
  id: string,
  kind: string,
  number: number,
  parentElementId: string | null,
): void {
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, SPEC_ID, kind, number, parentElementId, NOW);
}

function insertVersion(
  db: Db,
  revisionId: string,
  elementId: string,
  position: number,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    revisionId,
    elementId,
    position,
    JSON.stringify(payload),
    `hash-${revisionId}-${elementId}`,
    NOW,
    NOW,
  );
}

/** Rewrites one element of the open draft in place, as a later author write. */
function editDraftElement(
  db: Db,
  elementId: string,
  payload: Record<string, unknown>,
): void {
  const changed = db
    .prepare(
      `UPDATE spec_element_versions
          SET payload_json = ?, payload_hash = ?,
              element_version = element_version + 1
        WHERE revision_id = ? AND element_id = ?`,
    )
    .run(
      JSON.stringify(payload),
      `hash-${DRAFT_REVISION_ID}-${elementId}-edited`,
      DRAFT_REVISION_ID,
      elementId,
    );
  if (changed.changes !== 1) throw new Error(`no draft row for ${elementId}`);
}
