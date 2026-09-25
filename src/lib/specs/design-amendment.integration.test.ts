import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";

import { createAuthoringService } from "./authoring-service";
import { draftAuthoringSequence } from "./authoring-sequence";
import { createSpecEventsPublisher } from "./events";
import { revisionReviewHash } from "./review-hash";
import { createReviewService } from "./review-service";
import type { SpecRevisionSnapshot } from "./schemas";

const PROJECT = "/repos/design-amendment";
const AGENT = { kind: "agent", conversationId: "author" } as const;
const HUMAN = { kind: "human" } as const;

function createWorld() {
  const persistence = createPersistenceFixture();
  persistence.seedProject(PROJECT);
  const { db, specs } = persistence;
  const attention = createSpecEventsRepo(db);
  let sequence = 0;
  const deps = {
    specs,
    review: createSpecReviewRepo(db),
    links: createSpecLinksRepo(db),
    attention,
    events: createSpecEventsPublisher({
      appendInTransaction: attention.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newId: (prefix: string) => `${prefix}-${++sequence}`,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, ++sequence)).toISOString(),
  };
  return {
    persistence,
    specs,
    plans: createSpecDeliveryPlanRepo(db, {
      appendEvent: attention.appendInTransaction,
    }),
    authoring: createAuthoringService(deps),
    reviewing: createReviewService({
      ...deps,
      delivery: createSpecDeliveryRepo(db),
    }),
  };
}

let world: ReturnType<typeof createWorld>;
beforeEach(() => {
  world = createWorld();
});
afterEach(() => world.persistence.close());

const decision = (chosenApproach: string) => ({
  kind: "decision" as const,
  title: "Amend the existing design",
  chosenApproach,
  rejectedAlternatives: [],
  reason: "Preserve the approved contract.",
  tracedRequirementElementIds: ["requirement-1"],
});

async function snapshot(revisionId: string): Promise<SpecRevisionSnapshot> {
  const value = await world.specs.getRevisionSnapshot(revisionId);
  if (value === null) throw new Error("missing snapshot");
  return value;
}

/** The review token for the draft content as it stands right now. */
async function reviewHash(revisionId: string): Promise<string> {
  return revisionReviewHash(await snapshot(revisionId));
}

async function approve(specId: string, revisionId: string) {
  const proposal = await world.authoring.proposeRevision({
    specId,
    revisionId,
    actor: AGENT,
  });
  expect(proposal).toMatchObject({ ok: true, absorbedSignOff: false });
  expect(
    await world.reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      actor: HUMAN,
      approver: "Alex",
      expectedReviewHash: await reviewHash(revisionId),
    }),
  ).toMatchObject({ ok: true });
}

async function approvedDesign() {
  const created = await world.authoring.createSpec({
    projectPath: PROJECT,
    slug: "design-amendment",
    name: "Design amendment",
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Approved requirements remain unchanged.",
        priority: "must",
        risk: "high",
      },
    },
    actor: AGENT,
  });
  const specId = created.spec.id;
  await world.authoring.upsertDraftElements({
    specId,
    revisionId: created.draft.id,
    actor: AGENT,
    elements: [
      {
        elementId: "criterion-1",
        kind: "criterion",
        parentElementId: "requirement-1",
        position: 0,
        baseElementVersion: null,
        payload: {
          kind: "criterion",
          text: "A design correction retains approved requirements.",
          validationStrategy: { kinds: ["test_run"] },
        },
      },
      {
        elementId: "intent",
        kind: "section",
        parentElementId: null,
        position: 1,
        baseElementVersion: null,
        payload: {
          kind: "section",
          role: "intent_problem",
          title: "Intent",
          body: "Make a focused design correction.",
        },
      },
    ],
  });
  await approve(specId, created.draft.id);
  const design = await world.authoring.openAmendment({ specId, actor: AGENT });
  for (const [index, id] of ["decision-1", "decision-2"].entries()) {
    await world.authoring.upsertDraftElement({
      specId,
      revisionId: design.revision.id,
      elementId: id,
      kind: "decision",
      parentElementId: null,
      position: index + 2,
      payload: decision(`Supported approach ${index + 1}.`),
      baseElementVersion: null,
      actor: AGENT,
    });
  }
  await approve(specId, design.revision.id);
  return { specId, requirements: created.draft, design: design.revision };
}

async function openDesignAmendment() {
  const base = await approvedDesign();
  const pinnedAttempt = world.plans.open({
    attempt: {
      id: "existing-attempt",
      spec_id: base.specId,
      pinned_revision_id: base.design.id,
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: JSON.stringify({
        schemaVersion: 4,
        binding: { dispositions: [] },
      }),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      workflow_definition_id: null,
      created_at: "2026-09-23T00:00:00.000Z",
      updated_at: "2026-09-23T00:00:00.000Z",
    },
    actor: AGENT,
    occurredAt: "2026-09-23T00:00:00.000Z",
  });
  const { revision } = await world.authoring.openAmendment({
    specId: base.specId,
    actor: AGENT,
  });
  expect(revision).toMatchObject({
    authoringStage: "design",
    state: "draft",
    basedOnRevisionId: base.design.id,
  });
  return { ...base, revision, pinnedAttempt };
}

describe("approved Design amendments", () => {
  it("opens Design, carries unchanged approvals, and owes only the changed decision and Design sign-off", async () => {
    const { specId, design, revision, pinnedAttempt } =
      await openDesignAmendment();
    const baseline = await snapshot(design.id);
    await world.authoring.upsertDraftElement({
      specId,
      revisionId: revision.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      position: 2,
      payload: decision("Corrected approach."),
      baseElementVersion: 1,
      actor: AGENT,
    });
    const current = await snapshot(revision.id);
    const contract = (value: SpecRevisionSnapshot) =>
      value.elements
        .filter(
          ({ element }) =>
            element.kind === "requirement" ||
            element.kind === "criterion" ||
            element.id === "intent",
        )
        .map(({ element, version }) => ({
          element,
          payload: version.payload,
          version: version.elementVersion,
        }));
    expect(contract(current)).toEqual(contract(baseline));
    expect(
      draftAuthoringSequence({
        policy: { preset: "contract-bearing" },
        snapshot: current,
        governanceBaseSnapshot: baseline,
      })?.nextTransition.consultedGates,
    ).toEqual([{ gate: "design", dial: "gate" }]);
    const proposal = await world.authoring.proposeRevision({
      specId,
      revisionId: revision.id,
      actor: AGENT,
    });
    expect(proposal).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: { state: "draft" },
    });
    if (!proposal.ok) throw new Error("expected proposal");
    expect(proposal.pendingBlock?.outstandingSubjects).toEqual([
      { gate: "design", subject: "D1", elementId: "decision-1" },
    ]);
    expect(proposal.approvalLedger.subjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "D1", classification: "pending" }),
        expect.objectContaining({ subject: "D2", classification: "carried" }),
      ]),
    );
    expect(
      await world.reviewing.signOffRevision({
        specId,
        revisionId: revision.id,
        actor: AGENT,
        approver: "agent",
        expectedReviewHash: await reviewHash(revision.id),
      }),
    ).toMatchObject({ ok: false, refusal: { code: "human_act_required" } });
    expect(
      await world.reviewing.approveRemainingAndSignOff({
        specId,
        revisionId: revision.id,
        actor: HUMAN,
        approver: "Alex",
        expectedReviewHash: await reviewHash(revision.id),
      }),
    ).toMatchObject({ ok: true });
    expect((await snapshot(design.id)).revision).toEqual(baseline.revision);
    expect((await snapshot(revision.id)).revision.state).toBe("approved");
    expect(world.plans.findAttemptById(pinnedAttempt.id)).toEqual(
      pinnedAttempt,
    );
  });

  it("refuses Requirements writes and removals until the explicit return path is used", async () => {
    const { specId, revision } = await openDesignAmendment();
    const initial = await snapshot(revision.id);
    const requirement = initial.elements.find(
      ({ element }) => element.id === "requirement-1",
    );
    if (requirement === undefined) throw new Error("missing requirement");
    await expect(
      world.authoring.upsertDraftElement({
        specId,
        revisionId: revision.id,
        elementId: "requirement-1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: requirement.version.payload,
        baseElementVersion: 1,
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ code: "stage_blocked" });
    await expect(
      world.authoring.removeDraftElement({
        specId,
        revisionId: revision.id,
        elementId: "criterion-1",
        baseElementVersion: 1,
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ code: "stage_blocked" });
    expect((await snapshot(revision.id)).elements).toEqual(initial.elements);
  });

  it("returns a Design amendment to Requirements over the approved Design, dropping only its unapproved edits", async () => {
    const { specId, design, revision } = await openDesignAmendment();
    await world.authoring.upsertDraftElement({
      specId,
      revisionId: revision.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      position: 2,
      payload: decision("Unapproved correction."),
      baseElementVersion: 1,
      actor: AGENT,
    });

    const returned = await world.authoring.returnToRequirements({
      specId,
      expectedRevisionId: revision.id,
      reason: "Contract change is required.",
      actor: AGENT,
    });

    expect(returned.revision).toMatchObject({
      authoringStage: "requirements",
      basedOnRevisionId: design.id,
    });
    expect((await snapshot(revision.id)).revision.state).toBe("withdrawn");
    const payloads = (value: SpecRevisionSnapshot) =>
      value.elements.map(({ version }) => version.payload);
    expect(payloads(await snapshot(returned.revision.id))).toEqual(
      payloads(await snapshot(design.id)),
    );
  });

  it("retains the Requirements gate when an intent section becomes design narrative", async () => {
    const { specId, design, revision } = await openDesignAmendment();
    await world.authoring.upsertDraftElement({
      specId,
      revisionId: revision.id,
      elementId: "intent",
      kind: "section",
      parentElementId: null,
      position: 1,
      payload: {
        kind: "section",
        role: "design_narrative",
        title: "Reclassified intent",
        body: "Changes the approved contract boundary.",
      },
      baseElementVersion: 1,
      actor: AGENT,
    });
    expect(
      draftAuthoringSequence({
        policy: { preset: "contract-bearing" },
        snapshot: await snapshot(revision.id),
        governanceBaseSnapshot: await snapshot(design.id),
      })?.nextTransition.consultedGates.map(({ gate }) => gate),
    ).toEqual(["requirements", "design"]);
    await world.specs.updateGatePolicy({
      specId,
      gatePolicy: {
        preset: "contract-bearing",
        overrides: { design: "notify" },
      },
      updatedAt: "2026-09-23T01:00:00.000Z",
    });
    const proposal = await world.authoring.proposeRevision({
      specId,
      revisionId: revision.id,
      actor: AGENT,
    });
    expect(proposal).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: { state: "draft" },
    });
    if (!proposal.ok) throw new Error("expected proposal");
    expect(proposal.pendingBlock?.gates.map(({ gate }) => gate)).toEqual([
      "requirements",
    ]);
    expect(proposal.nextAction).toMatchObject({
      kind: "sign_off_revision",
      actsNext: "human",
    });
    expect(
      await world.reviewing.signOffRevision({
        specId,
        revisionId: revision.id,
        actor: HUMAN,
        approver: "Alex",
        expectedReviewHash: await reviewHash(revision.id),
      }),
    ).toMatchObject({ ok: true });
    expect((await snapshot(revision.id)).revision.state).toBe("approved");
  });

  it("requires renewed Requirements approval for a changed requirement citation", async () => {
    const { specId, revision } = await openDesignAmendment();
    const assumption = await world.reviewing.proposeAssumption({
      specId,
      elementId: null,
      text: "The contract depends on the cited premise.",
      actor: AGENT,
    });
    if (!assumption.ok) throw new Error("expected assumption");
    expect(
      await world.reviewing.disposeAssumption({
        specId,
        assumptionId: assumption.value.id,
        recordVersion: 1,
        disposition: "confirmed",
        actor: HUMAN,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await world.reviewing.citeAssumption({
        specId,
        assumptionId: assumption.value.id,
        revisionId: revision.id,
        elementHandle: "R1",
        expectedCitationVersion: revision.citationVersion,
        actor: AGENT,
      }),
    ).toMatchObject({ ok: true });
    const proposal = await world.authoring.proposeRevision({
      specId,
      revisionId: revision.id,
      actor: AGENT,
    });
    if (!proposal.ok) throw new Error("expected proposal");
    expect(proposal.pendingBlock?.outstandingSubjects).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ]);
    expect(proposal.pendingBlock?.gates.map(({ gate }) => gate)).toEqual([
      "requirements",
      "design",
    ]);
    expect(
      await world.reviewing.signOffRevision({
        specId,
        revisionId: revision.id,
        actor: HUMAN,
        approver: "Alex",
        expectedReviewHash: await reviewHash(revision.id),
      }),
    ).toMatchObject({ ok: false });
    expect((await snapshot(revision.id)).revision.state).toBe("draft");
  });
});
