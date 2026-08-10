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
import {
  specGateDialSchema,
  specGatePresetSchema,
  type SpecGatePolicy,
} from "./schemas";
import { undecidedAuthoringStages } from "./transitions";

const PROJECT_PATH = "/repos/native-sdd-policy-staging";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let specEvents: ReturnType<typeof createSpecEventsRepo>;
let authoring: AuthoringService;
let reviewing: ReviewService;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  reviewRepo = createSpecReviewRepo(db);
  specEvents = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: specEvents.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  let idSequence = 0;
  let timeSequence = 0;
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
      return `2026-07-25T09:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  });
});

afterEach(() => db.close());

async function authoredSpec(slug: string, gatePolicy: SpecGatePolicy) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug,
    name: slug,
    gatePolicy,
    initialElement: {
      elementId: `${slug}-requirement-1`,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "A policy change states its consequences.",
        priority: "must",
        risk: "high",
      },
    },
    actor: AGENT,
  });
  await authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: `${slug}-criterion-1`,
    kind: "criterion",
    parentElementId: `${slug}-requirement-1`,
    position: 1,
    payload: {
      kind: "criterion",
      text: "The remaining stage sequence is reported.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: AGENT,
  });
  return created;
}

describe("R25 policy-change staging semantics", () => {
  it("pins the open draft's stage and reports the sequence it still owes under the new dials", async () => {
    const created = await authoredSpec("pin-forward", {
      preset: "contract-bearing",
    });
    expect(created.draft.authoringStage).toBe("requirements");

    const result = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "fast-path" },
      hardConfirmed: true,
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spec.gatePolicy).toEqual({ preset: "fast-path" });
    expect(result.value.authoringSequence).not.toBeNull();
    expect(result.value.authoringSequence?.pinnedStage).toBe("requirements");
    expect(
      result.value.authoringSequence?.stages.map((step) => [
        step.stage,
        step.dial,
      ]),
    ).toEqual([
      ["requirements", "combined-approval"],
      ["design", "combined-approval"],
    ]);
    expect(result.value.authoringSequence?.nextTransition).toEqual({
      stage: "requirements",
      action: "propose",
      requiresHumanSignOff: true,
      consultedGates: [{ gate: "requirements", dial: "combined-approval" }],
      governanceConsultedGates: ["requirements"],
    });

    const reloaded = await specs.findDraft(created.spec.id);
    expect(reloaded?.authoringStage).toBe("requirements");
  });

  it("never moves a design-stage draft backward when the policy tightens", async () => {
    const created = await authoredSpec("pin-backward", { preset: "fast-path" });
    expect(created.draft.authoringStage).toBe("design");

    const result = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "contract-bearing" },
      hardConfirmed: true,
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authoringSequence?.pinnedStage).toBe("design");
    expect(result.value.authoringSequence?.stages).toEqual([
      {
        stage: "design",
        gate: "design",
        dial: "gate",
        concludedBy: "propose",
        requiresHumanSignOff: true,
      },
    ]);
    expect((await specs.findDraft(created.spec.id))?.authoringStage).toBe(
      "design",
    );
  });

  it("synthesizes no approval or gate admission for a transition that already occurred", async () => {
    const created = await authoredSpec("no-synthesis", {
      preset: "contract-bearing",
    });

    await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
      actor: HUMAN,
    });

    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect(reviewRepo.findGateAdmissionsBySpecId(created.spec.id)).toEqual([]);
  });

  it("never restages a proposed revision and reports no sequence for it", async () => {
    const created = await authoredSpec("no-restage", { preset: "fast-path" });
    const proposed = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    expect(proposed.ok).toBe(true);

    const result = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "contract-bearing" },
      hardConfirmed: true,
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authoringSequence).toBeNull();
    const revisions = await specs.listRevisions(created.spec.id);
    expect(revisions.map((revision) => revision.authoringStage)).toEqual([
      "design",
    ]);
    expect(revisions[0]?.state).toBe("proposed");
  });

  it("records the previous policy, the resulting policy, and the pinned stage on the policy event", async () => {
    const created = await authoredSpec("policy-record", {
      preset: "contract-bearing",
    });

    await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "fast-path" },
      hardConfirmed: true,
      actor: HUMAN,
    });

    const policyEvent = specEvents
      .findBySpecId(created.spec.id)
      .map((row) => ({
        actor: JSON.parse(row.actor_json) as unknown,
        payload: JSON.parse(row.payload_json) as { kind?: string },
      }))
      .find((row) => row.payload.kind === "policy-changed");
    expect(policyEvent).toBeDefined();
    expect(policyEvent?.actor).toEqual({ kind: "human" });
    expect(policyEvent?.payload).toEqual({
      kind: "policy-changed",
      previousPolicy: { preset: "contract-bearing" },
      policy: { preset: "fast-path" },
      pinnedAuthoringStage: "requirements",
    });
  });

  it("admits every policy shape the schema can express while a wider-stage draft is open", async () => {
    const shapes: SpecGatePolicy[] = specGatePresetSchema.options.flatMap(
      (preset) => [
        { preset },
        ...(["requirements", "design", "plan"] as const).flatMap((gate) =>
          specGateDialSchema.options.map((dial) => ({
            preset,
            overrides: { [gate]: dial },
          })),
        ),
      ],
    );

    for (const [index, proposedPolicy] of shapes.entries()) {
      const created = await authoredSpec(`sweep-${index}`, {
        preset: "fast-path",
      });
      db.prepare(
        "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
      ).run(created.draft.id);
      expect(undecidedAuthoringStages(proposedPolicy, "plan")).toEqual([]);

      const result = await reviewing.changePolicy({
        specId: created.spec.id,
        proposedPolicy,
        hardConfirmed: true,
        actor: HUMAN,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.authoringSequence?.pinnedStage).toBe("plan");
    }
  });
});
