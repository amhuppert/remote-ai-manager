import { describe, expect, it } from "vitest";
import {
  DELIVERY_PLAN_DISPOSITIONS,
  deliveryPlanDocumentSchema,
  deliveryPlanHash,
  emptyDeliveryPlanDocument,
  postLaunchPathActs,
  postLaunchPathsSentence,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryPlanAttemptStatusSchema,
  specDeliveryPlanAttemptRowSchema,
  specDeliveryPlanSnapshotRowSchema,
} from "./schemas";

function maximalDocument(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    dispositions: [
      {
        criterionElementId: "criterion-selected",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: "Owned by the schema context.",
      },
      {
        criterionElementId: "criterion-delivered",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-earlier",
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "criterion-reaffirmed",
        disposition: "reaffirmed",
        deliveredByExecutionId: "execution-earlier",
        reaffirmation: {
          actor: { kind: "human" },
          at: "2026-08-07T10:00:00.000Z",
          basisRevisionId: "revision-prior",
          basis: [
            {
              elementId: "req-1",
              reason: "parent_requirement",
              baseHash: "req-1-a",
              currentHash: "req-1-b",
            },
          ],
        },
        note: "Parent requirement reworded; the proof still holds.",
      },
    ],
    contexts: [
      {
        contextId: "ctx-schema",
        title: "Schema and store",
        contextType: "delivery",
        criterionElementIds: ["criterion-selected"],
        acceptanceContract: ["The attempt round-trips through SQLite."],
        proofPlan: [
          {
            criterionElementId: "criterion-selected",
            evidenceKinds: ["validator_verdict"],
            note: "Contract test asserts the reload.",
          },
        ],
      },
      {
        contextId: "ctx-closeout",
        title: "Closeout",
        contextType: "closeout",
        criterionElementIds: [],
        acceptanceContract: ["The branch merges with a green pre-merge run."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-schema",
        contextId: "ctx-schema",
        title: "Define the schemas",
        instructions: "Write the zod document and row schemas.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-selected"],
      },
    ],
    edges: [
      {
        edgeId: "edge-schema-closeout",
        fromContextId: "ctx-schema",
        toContextId: "ctx-closeout",
      },
    ],
    wiring: [
      {
        capabilityId: "delivery-plan-repo",
        criterionElementIds: ["criterion-selected"],
        owner: {
          kind: "call_site",
          contextId: "ctx-schema",
          locator: "src/lib/state-store/index.ts",
        },
      },
      {
        capabilityId: "delivery-plan-cli",
        criterionElementIds: ["criterion-selected"],
        owner: { kind: "downstream", contextId: "ctx-closeout" },
      },
    ],
    policyOverrides: [
      {
        key: "validation.preMerge",
        value: "typecheck,lint",
        rationale: "The full suite runs once at closeout.",
      },
    ],
    touchedSurfaces: ["src/lib/specs/", "src/lib/state-store/"],
    governance: {
      mission: "Author the delivery plan in the graph vocabulary.",
      charterInvariants: [
        {
          id: "durability-contracts",
          statement: "Persisted fields round-trip.",
        },
        {
          id: "audited-transitions",
          statement: "Every transition is audited.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "final-design",
          label: "Final agreed design",
          type: "document",
          locator: "command-center#47 attachment f7b542c4",
          description: "Section 4 owns the document shape.",
          appliesTo: null,
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck", "lint", "test"],
    },
  });
}

describe("delivery plan document", () => {
  it("carries the six-value disposition law", () => {
    expect([...DELIVERY_PLAN_DISPOSITIONS]).toEqual([
      "selected",
      "deferred",
      "waived",
      "delivered_elsewhere",
      "reaffirmed",
      "pending_reaffirmation",
    ]);
  });

  it("parses a maximal document and rejects an unknown key", () => {
    const document = maximalDocument();
    expect(document.contexts.map((context) => context.contextId)).toEqual([
      "ctx-schema",
      "ctx-closeout",
    ]);
    expect(document.wiring[1]?.owner).toEqual({
      kind: "downstream",
      contextId: "ctx-closeout",
    });

    const withUnknownKey = deliveryPlanDocumentSchema.safeParse({
      ...document,
      laneGroup: "compilation-inferred",
    });
    expect(withUnknownKey.success).toBe(false);
  });

  it("starts empty so an opened attempt has every section present", () => {
    const empty = emptyDeliveryPlanDocument();
    expect(deliveryPlanDocumentSchema.safeParse(empty).success).toBe(true);
    expect(empty.dispositions).toEqual([]);
    expect(empty.contexts).toEqual([]);
  });

  it("refuses a call-site owner with no locator", () => {
    const document = maximalDocument();
    const parsed = deliveryPlanDocumentSchema.safeParse({
      ...document,
      wiring: [
        {
          capabilityId: "delivery-plan-repo",
          criterionElementIds: [],
          owner: { kind: "call_site", contextId: "ctx-schema" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("deliveryPlanHash", () => {
  it("is stable across the key order a caller's JSON happened to carry", () => {
    const document = maximalDocument();
    const reordered: DeliveryPlanDocument = {
      governance: document.governance,
      touchedSurfaces: document.touchedSurfaces,
      policyOverrides: document.policyOverrides,
      wiring: document.wiring,
      edges: document.edges,
      tasks: document.tasks,
      contexts: document.contexts,
      dispositions: document.dispositions,
    };
    expect(
      deliveryPlanHash({
        pinnedRevisionId: "revision-1",
        draftRevision: 1,
        document: reordered,
      }),
    ).toBe(
      deliveryPlanHash({
        pinnedRevisionId: "revision-1",
        draftRevision: 1,
        document,
      }),
    );
  });

  it("changes with the pinned revision, the draft revision, or any content", () => {
    const document = maximalDocument();
    const base = deliveryPlanHash({
      pinnedRevisionId: "revision-1",
      draftRevision: 1,
      document,
    });

    expect(
      deliveryPlanHash({
        pinnedRevisionId: "revision-2",
        draftRevision: 1,
        document,
      }),
    ).not.toBe(base);
    // A reopen bumps the draft revision, so a re-propose of byte-identical
    // content is still a new plan identity that needs its own approval.
    expect(
      deliveryPlanHash({
        pinnedRevisionId: "revision-1",
        draftRevision: 2,
        document,
      }),
    ).not.toBe(base);
    expect(
      deliveryPlanHash({
        pinnedRevisionId: "revision-1",
        draftRevision: 1,
        document: {
          ...document,
          touchedSurfaces: [...document.touchedSurfaces, "src/cli/"],
        },
      }),
    ).not.toBe(base);
  });

  it("is a sha256 digest", () => {
    expect(
      deliveryPlanHash({
        pinnedRevisionId: "revision-1",
        draftRevision: 1,
        document: emptyDeliveryPlanDocument(),
      }),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("delivery plan row schemas", () => {
  it("carries every attempt lifecycle status a reopen has to reason about", () => {
    expect(deliveryPlanAttemptStatusSchema.options).toEqual([
      "draft",
      "proposed",
      "approved",
      "parked",
      "launched",
      "abandoned",
    ]);
  });

  it("parses a maximal attempt row and refuses a zero draft revision", () => {
    const row = specDeliveryPlanAttemptRowSchema.parse({
      id: "attempt-1",
      spec_id: "spec-1",
      pinned_revision_id: "revision-1",
      delta_basis_execution_id: "execution-earlier",
      status: "approved",
      draft_revision: 3,
      content_json: JSON.stringify(maximalDocument()),
      proposed_snapshot_id: "snapshot-1",
      approval_json: JSON.stringify({
        snapshotId: "snapshot-1",
        candidateId: "candidate-1",
        planHash: `sha256:${"a".repeat(64)}`,
        compiledDefinitionHash: `sha256:${"c".repeat(64)}`,
        approvedAt: "2026-08-07T11:00:00.000Z",
        approvedBy: { kind: "human" },
      }),
      prelaunch_json: null,
      launched_execution_id: null,
      created_at: "2026-08-07T09:00:00.000Z",
      updated_at: "2026-08-07T11:00:00.000Z",
    });
    expect(row.draft_revision).toBe(3);

    expect(
      specDeliveryPlanAttemptRowSchema.safeParse({
        ...row,
        draft_revision: 0,
      }).success,
    ).toBe(false);
  });

  it("parses a maximal snapshot row", () => {
    const row = specDeliveryPlanSnapshotRowSchema.parse({
      id: "snapshot-1",
      attempt_id: "attempt-1",
      draft_revision: 3,
      plan_hash: `sha256:${"a".repeat(64)}`,
      content_json: JSON.stringify(maximalDocument()),
      pinned_revision_id: "revision-1",
      proposed_at: "2026-08-07T10:30:00.000Z",
      proposed_by_json: JSON.stringify({
        kind: "agent",
        conversationId: "conversation-1",
        backend: "claude",
      }),
    });
    expect(row.plan_hash).toMatch(/^sha256:/);
  });
});

/**
 * Every refusal and receipt that names a way out of a launched run reads this
 * one list, so the list itself is where "exactly three" has to be provable. A
 * fourth entry appearing here would mean some surface is offering a way to
 * change a launched definition other than the audited amendment.
 */
describe("post-launch paths", () => {
  it("offers exactly the three enumerated exits, and no fourth", () => {
    const acts = postLaunchPathActs({
      slug: "native-sdd",
      executionId: "execution-1",
    });

    expect(acts).toHaveLength(3);
    expect(acts[0]).toContain(
      "cctl spec capture native-sdd --file <task.json>",
    );
    expect(acts[0]).not.toContain("--blocking-reason");
    expect(acts[1]).toContain(
      "cctl spec capture native-sdd --file <task.json>",
    );
    expect(acts[1]).toContain("--blocking-reason <why>");
    expect(acts[2]).toContain("cctl workflow live amend");
    // The audited amendment is the only one of the three that touches the
    // running definition; the other two must not claim to.
    expect(acts[0]).not.toContain("cctl workflow live amend");
    expect(acts[1]).not.toContain("cctl workflow live amend");
  });

  it("addresses the run itself where the caller has no slug in hand", () => {
    const acts = postLaunchPathActs({ executionId: "execution-1" });

    expect(acts[0]).toContain("--execution execution-1");
    expect(acts[1]).toContain("--execution execution-1");
  });

  it("states all three in one sentence naming the pinned run", () => {
    const sentence = postLaunchPathsSentence({
      slug: "native-sdd",
      executionId: "execution-1",
    });

    expect(sentence).toContain("running as execution execution-1");
    expect(sentence).toContain("three post-launch paths");
    for (const act of postLaunchPathActs({
      slug: "native-sdd",
      executionId: "execution-1",
    })) {
      expect(sentence).toContain(act);
    }
  });
});
