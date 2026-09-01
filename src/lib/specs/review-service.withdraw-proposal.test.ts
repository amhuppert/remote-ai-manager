import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { deriveNotificationOutcomes } from "@/components/session/sidebar/active-work-adapters";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
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
import { WITHDRAW_AFTER_ENGAGEMENT_RATIONALE } from "./refusal-rationale";
import { createReviewService, type ReviewService } from "./review-service";
import type { ActorProvenance, SpecGatePolicy } from "./schemas";

const PROJECT_PATH = "/repos/withdraw-proposal";
const PROPOSER = { kind: "agent", conversationId: "conversation-1" } as const;
const OTHER_AGENT = {
  kind: "agent",
  conversationId: "conversation-2",
} as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let specEvents: ReturnType<typeof createSpecEventsRepo>;
let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
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
      return `2026-08-02T10:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  notificationsRepo = createNotificationsRepo(db);
  const notifications = createNotificationsService({
    repo: () => notificationsRepo,
    publish: () => ({ delivered: true }),
    dispatchPush: () => {},
  });
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
    // The real notifier, so the queue rows a withdrawal closes are the ones a
    // human would see rather than a fake's record of the call.
    notifier: createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(specId) {
        return notificationsRepo.findSpecNotificationsBySpecId(specId);
      },
      getProjectDisplayName: () => "withdraw-proposal-project",
    }),
  });
});

afterEach(() => db.close());

interface ProposedSpec {
  readonly specId: string;
  readonly revisionId: string;
}

/**
 * The requests still standing in the human's queue, as the Needs You list
 * derives them, addressed by the attention id each entry answers for.
 */
function queueEntryIds(): string[] {
  const rows = notificationsRepo.getNotifications({ limit: 100 }).notifications;
  const byNotificationId = new Map<string, string>(
    rows.flatMap((row) =>
      row.source === "spec"
        ? [[`notification:${row.id}`, row.gateRequestId] as const]
        : [],
    ),
  );
  return deriveNotificationOutcomes(rows, []).needsAction.flatMap((entry) => {
    const attentionId = byNotificationId.get(entry.id);
    return attentionId === undefined ? [] : [attentionId];
  });
}

/**
 * A design-stage revision under review, proposed by `proposer`. Every guard here
 * is measured against a real propose, so the durable propose event carries the
 * provenance the withdrawal has to match.
 */
async function proposeSpec(
  slug: string,
  proposer: ActorProvenance = PROPOSER,
  gatePolicy: SpecGatePolicy = { preset: "contract-bearing" },
): Promise<ProposedSpec> {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug,
    name: `Withdraw ${slug}`,
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: `${slug}-r1`,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "A proposing agent can end its own review attempt.",
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
      text: "The withdrawal opens exactly one follow-up draft.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: PROPOSER,
  });
  await specs.proposeRevision({
    revisionId: created.draft.id,
    proposedAt: "2026-08-02T09:58:00.000Z",
  });
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-08-02T09:58:01.000Z",
  });
  const design = await authoring.openAmendment({
    specId: created.spec.id,
    actor: PROPOSER,
  });
  await specs.updateGatePolicy({
    specId: created.spec.id,
    gatePolicy,
    updatedAt: "2026-08-02T09:59:59.000Z",
  });
  await authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: design.revision.id,
    elementId: `${slug}-d1`,
    kind: "decision",
    parentElementId: null,
    position: 2,
    payload: {
      kind: "decision",
      title: "Withdrawal owner",
      chosenApproach: "The proposing conversation owns its proposal.",
      rejectedAlternatives: [],
      reason: "A successor conversation is not the author.",
      tracedRequirementElementIds: [`${slug}-r1`],
    },
    baseElementVersion: null,
    actor: PROPOSER,
  });
  const proposed = await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: design.revision.id,
    actor: proposer,
  });
  if (!proposed.ok) throw new Error("the fixture propose was refused");
  return { specId: created.spec.id, revisionId: design.revision.id };
}

async function elementIdsOf(revisionId: string): Promise<string[]> {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  return (snapshot?.elements ?? []).map(({ element }) => element.id).sort();
}

async function reloadedDraft(specId: string) {
  const revisions = await specs.listRevisions(specId);
  return revisions.filter((revision) => revision.state === "draft");
}

function withdrawnByAuthorEvents(specId: string) {
  return specEvents
    .findBySpecId(specId)
    .filter((event) =>
      event.payload_json.includes('"proposal-withdrawn-by-author"'),
    );
}

describe("withdrawProposal", () => {
  it("withdraws the proposer's own untouched proposal and reopens it as one identical draft", async () => {
    const { specId, revisionId } = await proposeSpec("happy-path");
    const proposedElements = await elementIdsOf(revisionId);

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        withdrawn: { id: revisionId, state: "withdrawn" },
        draft: { state: "draft", basedOnRevisionId: revisionId },
      },
    });
    if (!result.ok) throw new Error("the withdrawal was refused");

    // Reload through the repository: an in-memory result cannot prove the
    // revision states or the follow-up draft survived the transaction.
    const reloadedWithdrawn = await specs.findRevision(revisionId);
    expect(reloadedWithdrawn?.state).toBe("withdrawn");
    const drafts = await reloadedDraft(specId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id: result.value.draft.id,
      basedOnRevisionId: revisionId,
      // Same stage: the follow-up continues the attempt, it does not advance.
      authoringStage: reloadedWithdrawn?.authoringStage,
    });
    expect(await elementIdsOf(result.value.draft.id)).toEqual(proposedElements);

    const events = withdrawnByAuthorEvents(specId);
    expect(events).toHaveLength(1);
    const payload: unknown = JSON.parse(events[0]?.payload_json ?? "{}");
    expect(payload).toMatchObject({
      kind: "proposal-withdrawn-by-author",
      revisionId,
      proposer: { kind: "agent", conversationId: "conversation-1" },
      withdrawnBy: { kind: "agent", conversationId: "conversation-1" },
      followUpDraftRevisionId: result.value.draft.id,
    });
  });

  /**
   * The receipt is where a reopen is priced. Reading only what the reopened
   * draft still owes says every approval the attempt collected is gone, so the
   * withdrawal answers with both sides of the account of the draft that now
   * exists — never of the revision it withdrew.
   */
  it("answers with the approval ledger of the reopened draft", async () => {
    const { specId, revisionId } = await proposeSpec("ledger");

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });

    if (!result.ok) throw new Error("the withdrawal was refused");
    expect(result.value.approvalLedger).toMatchObject({
      satisfied: 0,
      carried: 0,
      currentRevision: 0,
      importSettled: 0,
      combinedAct: 0,
      governedBy: "per_subject",
      carryRule: "unchanged subject content under the same applicable gate",
    });
    // The subjects are the reopened draft's, addressed by its own handles.
    expect(
      result.value.approvalLedger.subjects.map(
        ({ gate, subject, classification }) => [gate, subject, classification],
      ),
    ).toEqual([["design", "D1", "pending"]]);
  });

  it("clears the ended attempt's authoring attention and leaves nothing open", async () => {
    const { specId, revisionId } = await proposeSpec("attention");
    const requested = await reviewing.requestApproval({
      specId,
      revisionId,
      gate: "design",
      actor: PROPOSER,
    });
    // A second spec under review at the same gate: the withdrawal resolves the
    // attention ids of the attempt it ended, never everything the queue holds.
    const bystander = await proposeSpec("attention-bystander");
    const bystanderRequest = await reviewing.requestApproval({
      specId: bystander.specId,
      revisionId: bystander.revisionId,
      gate: "design",
      actor: PROPOSER,
    });
    if (!requested.ok || !bystanderRequest.ok) {
      throw new Error("an approval request was refused");
    }
    expect(specEvents.listOpenApprovalRequests(specId)).toHaveLength(1);
    expect(queueEntryIds().sort()).toEqual(
      [requested.value.attentionId, bystanderRequest.value.attentionId].sort(),
    );

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });
    expect(result.ok).toBe(true);

    expect(specEvents.listOpenApprovalRequests(specId)).toEqual([]);
    expect(queueEntryIds()).toEqual([bystanderRequest.value.attentionId]);
  });

  it("refuses a different conversation's agent, fail closed", async () => {
    const { specId, revisionId } = await proposeSpec("other-agent");

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: OTHER_AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "proposal_not_owned" },
    });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
    expect(await reloadedDraft(specId)).toEqual([]);
  });

  it("refuses a human caller, who ends a review from the other side", async () => {
    const { specId, revisionId } = await proposeSpec("human-caller");

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: HUMAN,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "proposal_not_owned",
        // A human is not sent to the agent verb: the two human exits differ in
        // whether the content comes back, so the refusal names both.
        instruction: expect.stringContaining("Request Changes"),
      },
    });
    if (result.ok) throw new Error("the human caller was not refused");
    expect(result.refusal.instruction).toContain("Withdraw");
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
  });

  it("refuses when the propose event carries human provenance", async () => {
    const { specId, revisionId } = await proposeSpec(
      "human-proposed",
      HUMAN,
      // A human propose only reaches `proposed` when a gate still owes an
      // approval; the combined dial would absorb the sign-off instead.
      { preset: "contract-bearing" },
    );

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "proposal_not_owned" },
    });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
  });

  it("refuses when the propose event's provenance is malformed or absent", async () => {
    const { specId, revisionId } = await proposeSpec("malformed");
    // An agent actor with no conversation cannot be matched against a caller,
    // so it fails closed rather than matching anyone.
    db.prepare(
      `UPDATE spec_events SET actor_json = ?
       WHERE spec_id = ? AND event_type = 'spec-revision-changed'
         AND payload_json LIKE '%"proposed"%'`,
    ).run('{"kind":"agent"}', specId);

    const malformed = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });
    expect(malformed).toMatchObject({
      ok: false,
      refusal: { code: "proposal_not_owned" },
    });

    db.prepare(
      `DELETE FROM spec_events
       WHERE spec_id = ? AND event_type = 'spec-revision-changed'
         AND payload_json LIKE '%"proposed"%'`,
    ).run(specId);
    const absent = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });
    expect(absent).toMatchObject({
      ok: false,
      refusal: { code: "proposal_not_owned" },
    });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
  });

  it("refuses after a human approval, and still refuses once that approval is withdrawn", async () => {
    const { specId, revisionId } = await proposeSpec("human-approved");
    const approved = await reviewing.approveItem({
      specId,
      revisionId,
      subjectKind: "requirement",
      elementId: "human-approved-r1",
      approver: "alex",
      actor: HUMAN,
    });
    expect(approved.ok).toBe(true);

    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });

    const unapproved = await reviewing.unapproveItem({
      specId,
      revisionId,
      subjectKind: "requirement",
      elementId: "human-approved-r1",
      actor: HUMAN,
    });
    expect(unapproved.ok).toBe(true);
    // The live approval row is gone. Only the durable event still records that
    // a human engaged with this attempt, and it is what has to refuse.
    expect(
      reviewRepo
        .findApprovalsBySpecId(specId)
        .filter((approval) => approval.element_id === "human-approved-r1"),
    ).toEqual([]);

    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
  });

  // The principle used to ride along at the end of the instruction, where it
  // read as an aside on the recovery step. As a typed field it is the reason
  // the refusal exists, and the instruction is left saying only what to do.
  it("carries the withdraw-after-engagement principle as a typed rationale, not as instruction prose", async () => {
    const { specId, revisionId } = await proposeSpec("typed-rationale");
    const approved = await reviewing.approveItem({
      specId,
      revisionId,
      subjectKind: "requirement",
      elementId: "typed-rationale-r1",
      approver: "alex",
      actor: HUMAN,
    });
    expect(approved.ok).toBe(true);

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          "Revision 2 is no longer an untouched proposal: a human has already approved or unapproved content on it.",
        ],
        rationale: WITHDRAW_AFTER_ENGAGEMENT_RATIONALE,
        instruction:
          "Ask a human to Request Changes on this revision in Spec Studio.",
      },
    });
  });

  // A rationale explains a "no". A receipt for something that happened has
  // nothing to justify, so nothing on the success path carries the field.
  it("puts no rationale on the receipt for a withdrawal that succeeds", async () => {
    // The slug must not contain the word the assertion scans for: element ids
    // derived from it surface in the receipt's approval ledger.
    const { specId, revisionId } = await proposeSpec("bare-success-receipt");

    const result = await reviewing.withdrawProposal({
      specId,
      revisionId,
      actor: PROPOSER,
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("rationale");
  });

  it("refuses once a human resolved or dismissed a review thread", async () => {
    const { specId, revisionId } = await proposeSpec("resolved-thread");
    await reviewing.comment({
      specId,
      revisionId,
      elementId: "resolved-thread-r1",
      threadId: "thread-1",
      parentCommentId: null,
      anchor: {
        sectionId: "requirements",
        headingLabel: "Requirements",
        line: 1,
        charStart: 0,
        charEnd: 17,
        quote: "A proposing agent",
        prefix: "",
        suffix: "",
        docRevision: revisionId,
      },
      body: "Name the refusal code.",
      blocking: true,
      actor: HUMAN,
    });
    const resolved = await reviewing.resolveThread({
      specId,
      revisionId,
      threadId: "thread-1",
      resolution: "resolved",
      actor: HUMAN,
    });
    expect(resolved.ok).toBe(true);

    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
  });

  it("allows the withdrawal while a human comment is still open", async () => {
    const { specId, revisionId } = await proposeSpec("open-comment");
    const comment = await reviewing.comment({
      specId,
      revisionId,
      elementId: "open-comment-r1",
      threadId: "thread-open",
      parentCommentId: null,
      anchor: {
        sectionId: "requirements",
        headingLabel: "Requirements",
        line: 1,
        charStart: 0,
        charEnd: 17,
        quote: "A proposing agent",
        prefix: "",
        suffix: "",
        docRevision: revisionId,
      },
      body: "This needs a refusal code.",
      blocking: true,
      actor: HUMAN,
    });
    expect(comment.ok).toBe(true);

    // Withdraw-and-fix is a faster instance of the sanctioned comment → revise
    // → re-review loop, and the thread survives into the follow-up revision.
    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: true });
    expect((await specs.findRevision(revisionId))?.state).toBe("withdrawn");
  });

  it("is not blocked by an agent approval request", async () => {
    const { specId, revisionId } = await proposeSpec(
      "agent-acts-only",
      PROPOSER,
      {
        preset: "contract-bearing",
        overrides: { requirements: "notify" },
      },
    );
    // Requirements admission belongs to its immutable checkpoint, never to
    // the separate Design proposal this withdrawal targets.
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(revisionId)
        .map(({ gate, basis }) => ({ gate, basis })),
    ).toEqual([]);
    const requested = await reviewing.requestApproval({
      specId,
      revisionId,
      gate: "design",
      actor: PROPOSER,
    });
    expect(requested.ok).toBe(true);

    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a stale revision token and a target that is no longer proposed", async () => {
    const { specId, revisionId } = await proposeSpec("stale-token");

    await expect(
      reviewing.withdrawProposal({
        specId,
        revisionId: "revision-that-never-existed",
        actor: PROPOSER,
      }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "not_found" } });

    const changed = await reviewing.requestChanges({
      specId,
      revisionId,
      actor: HUMAN,
    });
    expect(changed.ok).toBe(true);

    // The token the proposer holds now names a revision the human already
    // ended: the CAS check refuses rather than withdrawing something else.
    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });
  });

  it("refuses when a draft is already open on the spec", async () => {
    const { specId, revisionId } = await proposeSpec("open-draft");
    // An execution capture leaves a draft open beside the proposed revision;
    // opening a second one would give the spec two editable revisions.
    const draft = await specs.createDraftFromBase({
      id: "revision-capture-draft",
      specId,
      baseRevisionId: revisionId,
      authoringStage: "design",
      createdAt: "2026-08-02T10:30:00.000Z",
    });

    await expect(
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
    expect((await reloadedDraft(specId)).map(({ id }) => id)).toEqual([
      draft.id,
    ]);
  });

  it("serializes a concurrent human approval against the agent withdrawal", async () => {
    const { specId, revisionId } = await proposeSpec("concurrent");

    const [approval, withdrawal] = await Promise.all([
      reviewing.approveItem({
        specId,
        revisionId,
        subjectKind: "requirement",
        elementId: "concurrent-r1",
        approver: "alex",
        actor: HUMAN,
      }),
      reviewing.withdrawProposal({ specId, revisionId, actor: PROPOSER }),
    ]);

    // Both committing would leave a human approval stranded on a revision the
    // agent ended; both refusing would dead-end the attempt.
    expect([approval.ok, withdrawal.ok].filter(Boolean)).toHaveLength(1);
    const reloaded = await specs.findRevision(revisionId);
    expect(reloaded?.state).toBe(withdrawal.ok ? "withdrawn" : "proposed");
    expect(await reloadedDraft(specId)).toHaveLength(withdrawal.ok ? 1 : 0);
  });
});

describe("withdrawAndOpenDraft is shared with the human exits", () => {
  it("keeps human Request Changes opening one identical follow-up draft", async () => {
    const { specId, revisionId } = await proposeSpec("request-changes");
    const proposedElements = await elementIdsOf(revisionId);

    const result = await reviewing.requestChanges({
      specId,
      revisionId,
      actor: HUMAN,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        withdrawn: { id: revisionId, state: "withdrawn" },
        draft: { state: "draft", basedOnRevisionId: revisionId },
      },
    });
    if (!result.ok) throw new Error("request changes was refused");
    expect(await elementIdsOf(result.value.draft.id)).toEqual(proposedElements);
    expect(await reloadedDraft(specId)).toHaveLength(1);
  });

  it("refuses human Request Changes when a draft is already open", async () => {
    const { specId, revisionId } = await proposeSpec("request-changes-draft");
    await specs.createDraftFromBase({
      id: "revision-conflicting-draft",
      specId,
      baseRevisionId: revisionId,
      authoringStage: "design",
      createdAt: "2026-08-02T10:30:00.000Z",
    });

    await expect(
      reviewing.requestChanges({ specId, revisionId, actor: HUMAN }),
    ).resolves.toMatchObject({ ok: false, refusal: { code: "gate_blocked" } });
    expect((await specs.findRevision(revisionId))?.state).toBe("proposed");
    expect(await reloadedDraft(specId)).toHaveLength(1);
  });

  it("keeps plain human Withdraw ending the attempt with no follow-up draft", async () => {
    const { specId, revisionId } = await proposeSpec("plain-withdraw");

    await expect(
      reviewing.withdraw({ specId, revisionId, actor: HUMAN }),
    ).resolves.toMatchObject({ ok: true, value: { state: "withdrawn" } });

    expect(await reloadedDraft(specId)).toEqual([]);
  });
});
