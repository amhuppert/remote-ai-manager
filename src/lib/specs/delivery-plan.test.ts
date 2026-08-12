import { describe, expect, it } from "vitest";
// Test-only: the drift pin below compares the local mirror against the graph
// tier's own placement schema. Production code in `./delivery-plan` must not
// import this module — the mirror exists precisely so it does not have to.
import { contextPlacementSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  DELIVERY_PLAN_DISPOSITIONS,
  deliveryPlanContextPlacementSchema,
  deliveryPlanContextSchema,
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  postLaunchPathActs,
  postLaunchPathsSentence,
  type DeliveryPlanDocument,
} from "./delivery-plan";
// The hash lives in its own module so `./delivery-plan` stays browser-safe; it
// is exercised here because plan identity is a property of the document these
// fixtures build.
import { deliveryPlanHash } from "./delivery-plan-hash";
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

/**
 * The plan tier authors placement in the graph tier's own vocabulary so
 * materialization is a copy rather than a translation. The shape is mirrored
 * locally because `delivery-plan.ts` is a client-importable leaf that must not
 * import `@/lib/workflow-graph`, so this pins the mirror: a placement one
 * schema admits and the other refuses is drift, and drift here means a plan
 * that proposes clean compiles into a definition the graph tier rejects.
 *
 * Test code may import the graph schema; production spec-tier code may not.
 */
describe("delivery plan context placement mirror", () => {
  const sharedMatrix: readonly (readonly [string, unknown])[] = [
    ["a full-access placement", { lane: "core", mode: "full" }],
    [
      "an owning placement",
      {
        lane: "store",
        mode: "owned",
        ownedPaths: ["src/lib/specs", "src/lib/state-store/index.ts"],
      },
    ],
    ["a read-only placement", { lane: "session", mode: "readOnly" }],
    [
      "stray ownedPaths on a full-access placement",
      { lane: "core", mode: "full", ownedPaths: ["src/lib/specs"] },
    ],
    [
      "stray ownedPaths on a read-only placement",
      { lane: "core", mode: "readOnly", ownedPaths: ["src/lib/specs"] },
    ],
    [
      "empty ownedPaths on an owning placement",
      { lane: "core", mode: "owned", ownedPaths: [] },
    ],
    [
      "a missing ownedPaths on an owning placement",
      { lane: "core", mode: "owned" },
    ],
    ["an unknown grade", { lane: "core", mode: "solo" }],
    ["a missing mode", { lane: "core" }],
    ["a missing lane", { mode: "full" }],
    ["an empty lane", { lane: "", mode: "full" }],
    ["a whitespace-only lane", { lane: "   ", mode: "full" }],
    ["an unknown key", { lane: "core", mode: "full", worktree: true }],
    ["a non-object placement", "core"],
    [
      "an absolute owned path",
      { lane: "core", mode: "owned", ownedPaths: ["/src/lib/specs"] },
    ],
    [
      "a windows-drive owned path",
      { lane: "core", mode: "owned", ownedPaths: ["C:/src/lib"] },
    ],
    [
      "a backslash owned path",
      { lane: "core", mode: "owned", ownedPaths: ["src\\lib\\specs"] },
    ],
    [
      "a trailing-separator owned path",
      { lane: "core", mode: "owned", ownedPaths: ["src/lib/specs/"] },
    ],
    [
      "a parent-segment owned path",
      { lane: "core", mode: "owned", ownedPaths: ["src/../lib"] },
    ],
    [
      "a current-segment owned path",
      { lane: "core", mode: "owned", ownedPaths: ["src/./lib"] },
    ],
    [
      "an empty-segment owned path",
      { lane: "core", mode: "owned", ownedPaths: ["src//lib"] },
    ],
    [
      "an untrimmed owned path",
      { lane: "core", mode: "owned", ownedPaths: [" src/lib"] },
    ],
    [
      "a repository-root owned path",
      { lane: "core", mode: "owned", ownedPaths: ["."] },
    ],
    [
      "a repository-root owned path with a separator",
      { lane: "core", mode: "owned", ownedPaths: ["./"] },
    ],
    ["an empty owned path", { lane: "core", mode: "owned", ownedPaths: [""] }],
    [
      "a .git owned path",
      { lane: "core", mode: "owned", ownedPaths: [".git/hooks"] },
    ],
    [
      "a case-folded .git owned path",
      { lane: "core", mode: "owned", ownedPaths: [".GIT"] },
    ],
    [
      "a .cc owned path",
      { lane: "core", mode: "owned", ownedPaths: [".cc/temp"] },
    ],
    [
      "a case-folded .cc owned path",
      { lane: "core", mode: "owned", ownedPaths: [".CC/temp"] },
    ],
    [
      "a dotfile owned path that only looks like git metadata",
      { lane: "core", mode: "owned", ownedPaths: [".gitignore"] },
    ],
    [
      "a non-string owned path",
      { lane: "core", mode: "owned", ownedPaths: [{ path: "src/lib" }] },
    ],
    [
      "an owned path at the mirrored length bound",
      { lane: "core", mode: "owned", ownedPaths: [`src/${"a".repeat(496)}`] },
    ],
    [
      "a lane at the mirrored length bound",
      { lane: "a".repeat(120), mode: "full" },
    ],
  ];

  it.each(sharedMatrix)(
    "reaches the same verdict as contextPlacementSchema for %s",
    (_label, candidate) => {
      expect(
        deliveryPlanContextPlacementSchema.safeParse(candidate).success,
      ).toBe(contextPlacementSchema.safeParse(candidate).success);
    },
  );

  it("admits exactly the three authorable grades unchanged", () => {
    for (const placement of [
      { lane: "core", mode: "full" },
      {
        lane: "store",
        mode: "owned",
        ownedPaths: ["src/lib/specs", "docs/design"],
      },
      { lane: "session", mode: "readOnly" },
    ]) {
      expect(deliveryPlanContextPlacementSchema.parse(placement)).toEqual(
        placement,
      );
    }
  });

  /**
   * The plan document is stored whole in one TEXT column, so the mirror carries
   * blob bounds the graph tier has no reason to: these are the cases where the
   * two schemas legitimately disagree, and each one asserts the graph tier is
   * the more permissive side so the divergence stays deliberate.
   */
  it.each([
    ["a lane past the blob bound", { lane: "a".repeat(121), mode: "full" }],
    [
      "more owned paths than the blob bound",
      {
        lane: "core",
        mode: "owned",
        ownedPaths: Array.from({ length: 65 }, (_v, i) => `src/lib/p${i}`),
      },
    ],
    [
      "an owned path past the blob bound",
      { lane: "core", mode: "owned", ownedPaths: [`src/${"a".repeat(497)}`] },
    ],
  ])("refuses %s that the graph tier admits", (_label, candidate) => {
    expect(
      deliveryPlanContextPlacementSchema.safeParse(candidate).success,
    ).toBe(false);
    expect(contextPlacementSchema.safeParse(candidate).success).toBe(true);
  });

  it("admits owned paths up to the blob bound", () => {
    const placement = {
      lane: "core",
      mode: "owned",
      ownedPaths: Array.from({ length: 64 }, (_v, i) => `src/lib/p${i}`),
    };
    expect(deliveryPlanContextPlacementSchema.parse(placement)).toEqual(
      placement,
    );
  });
});

describe("delivery plan context placement field", () => {
  function contextWithout(): Record<string, unknown> {
    return {
      contextId: "ctx-schema",
      title: "Schema and store",
      contextType: "delivery",
      criterionElementIds: [],
      acceptanceContract: ["The attempt round-trips through SQLite."],
      proofPlan: [],
    };
  }

  it("stays optional so a plan that does not care omits it", () => {
    const parsed = deliveryPlanContextSchema.parse(contextWithout());
    expect(parsed).not.toHaveProperty("placement");
  });

  it("carries an authored placement through unchanged", () => {
    const placement = {
      lane: "store",
      mode: "owned",
      ownedPaths: ["src/lib/state-store"],
    };
    expect(
      deliveryPlanContextSchema.parse({ ...contextWithout(), placement }),
    ).toMatchObject({ placement });
  });

  it("refuses a malformed placement rather than dropping it", () => {
    expect(
      deliveryPlanContextSchema.safeParse({
        ...contextWithout(),
        placement: { lane: "store", mode: "owned", ownedPaths: [] },
      }).success,
    ).toBe(false);
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

  /**
   * `findAttemptsBySpecId` parses rows, never documents, so a document field
   * this build has not learned yet must not cost the whole result set. That
   * only holds while `content_json` stays an opaque JSON string here: giving
   * the row schema any knowledge of the document shape would turn a newer
   * build's attempt into a listing-wide failure instead of a per-attempt one.
   */
  it("keeps content_json opaque, so a newer document shape still parses as a row", () => {
    const [firstContext, ...restContexts] = maximalDocument().contexts;
    if (firstContext === undefined) throw new Error("fixture lost its context");
    const futureDocument = {
      ...maximalDocument(),
      contexts: [
        { ...firstContext, placement: { grade: "solo", lane: "lane-schema" } },
        ...restContexts,
      ],
    };
    expect(deliveryPlanDocumentSchema.safeParse(futureDocument).success).toBe(
      false,
    );

    const row = specDeliveryPlanAttemptRowSchema.parse({
      id: "attempt-future",
      spec_id: "spec-1",
      pinned_revision_id: "revision-1",
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: JSON.stringify(futureDocument),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      created_at: "2026-08-11T09:00:00.000Z",
      updated_at: "2026-08-11T09:00:00.000Z",
    });

    const stored: unknown = JSON.parse(row.content_json);
    expect(stored).toEqual(futureDocument);
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
