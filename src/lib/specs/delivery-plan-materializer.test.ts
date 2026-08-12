import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  workflowSemanticDefinitionSchema,
  type WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
// Test-only: the solo default is specified as the graph tier's own lane
// allocator, so the pins below name the reserved session spellings from their
// one owner rather than restating them. Production spec-tier code reaches the
// allocator, never these constants.
import {
  laneIdViolation,
  laneNameFromId,
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import {
  DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS,
  ACCEPTANCE_CONTRACT_SERIALIZATION,
  deliveryPlanCharter,
  deliveryPlanCompiledHash,
  materializeDeliveryPlan,
  type DeliveryPlanMaterialization,
} from "./delivery-plan-materializer";
import {
  materializationInput,
  planDocument,
  PINNED_REVISION_ID,
} from "./delivery-plan-materializer.fixture";
import { deliveryPlanHash } from "./delivery-plan-hash";
import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanContextPlacement,
  type DeliveryPlanDocument,
} from "./delivery-plan";

function materialize(
  input = materializationInput(),
): DeliveryPlanMaterialization {
  const result = materializeDeliveryPlan(input);
  if (!result.ok) {
    throw new Error(
      `expected materialization to succeed, refused: ${result.refusal.instruction}`,
    );
  }
  return result.value;
}

describe("materializeDeliveryPlan — exactness", () => {
  it("copies the authored charter rather than synthesizing one from the spec", () => {
    const input = materializationInput();
    const { definition } = materialize(input);

    expect(definition.charter).toEqual(
      deliveryPlanCharter(input.document.governance),
    );
    expect(definition.charter.mission).toBe(input.document.governance.mission);
    expect(definition.charter.invariants).toEqual(
      input.document.governance.charterInvariants,
    );
    expect(definition.charter.sourcesOfTruth).toEqual([
      {
        rank: 1,
        id: "final-design",
        label: "Final agreed design",
        type: "document",
        locator: "command-center#47 attachment f7b542c4",
        description: "Section 5 owns compilation as persisted materialization.",
        appliesTo: "every context",
        accessPolicy: "external-readonly",
      },
      {
        rank: 2,
        id: "current-code",
        label: "Current codebase",
        type: "code",
        locator: "src/lib/specs/**",
        description: "Mechanics follow HEAD where the design cites file:line.",
        accessPolicy: "worktree-relative",
      },
    ]);
  });

  it("renders acceptanceCriteria as the authored contract under one named serialization", () => {
    const input = materializationInput();
    const { definition } = materialize(input);

    const copyContext = definition.executionContexts.find(
      (context) => context.id === "ctx-copy",
    );
    expect(copyContext?.acceptanceCriteria).toBe(
      ACCEPTANCE_CONTRACT_SERIALIZATION([
        "The rendered acceptanceCriteria bytes equal the authored contract.",
        "No criterion text, proof plan, or wiring entry is appended to it.",
      ]),
    );
  });

  it("keeps criterion text, proof plans, and wiring out of acceptanceCriteria", () => {
    const { definition } = materialize();

    for (const context of definition.executionContexts) {
      expect(context.acceptanceCriteria).not.toContain(
        "The materializer copies the authored acceptance contract verbatim.",
      );
      expect(context.acceptanceCriteria).not.toContain(
        "Byte equality against the authored contract.",
      );
      expect(context.acceptanceCriteria).not.toContain(
        "delivery-plan-materializer",
      );
      expect(context.acceptanceCriteria).not.toContain("criterion-copy");
    }
  });

  it("leaves the rendered contract bytes unchanged when only criterion order and contribution annotations move", () => {
    const before = materialize();

    const document = planDocument();
    const reordered = {
      ...document,
      contexts: document.contexts.map((context) =>
        context.contextId === "ctx-copy"
          ? {
              ...context,
              criterionElementIds: [...context.criterionElementIds].reverse(),
              proofPlan: [...context.proofPlan].reverse(),
            }
          : context,
      ),
      tasks: document.tasks.map((task) =>
        task.taskId === "task-render"
          ? {
              ...task,
              contributesToCriterionElementIds: [
                "criterion-copy",
                "criterion-determinism",
              ],
            }
          : task,
      ),
    };
    const after = materialize(materializationInput({ document }));
    const afterReordered = materialize(
      materializationInput({ document: reordered }),
    );

    expect(
      after.definition.executionContexts.map((c) => c.acceptanceCriteria),
    ).toEqual(
      before.definition.executionContexts.map((c) => c.acceptanceCriteria),
    );
    expect(
      afterReordered.definition.executionContexts.map(
        (context) => context.acceptanceCriteria,
      ),
    ).toEqual(
      before.definition.executionContexts.map(
        (context) => context.acceptanceCriteria,
      ),
    );
  });
});

describe("materializeDeliveryPlan — structure is authored, never inferred", () => {
  it("materializes exactly the authored contexts, tasks, and edges", () => {
    const document = planDocument();
    const { definition } = materialize();

    expect(definition.executionContexts.map((context) => context.id)).toEqual([
      "ctx-copy",
      "ctx-preflight",
      "ctx-closeout",
    ]);
    expect(definition.edges).toEqual([
      {
        id: "edge-copy-to-closeout",
        sourceContextId: "ctx-copy",
        targetContextId: "ctx-closeout",
      },
      {
        id: "edge-preflight-to-closeout",
        sourceContextId: "ctx-preflight",
        targetContextId: "ctx-closeout",
      },
    ]);
    expect(definition.tasks.map((task) => task.id)).toEqual(
      document.tasks.map((task) => task.taskId),
    );
    expect(
      definition.tasks.map((task) => ({
        contextId: task.contextId,
        order: task.order,
      })),
    ).toEqual([
      { contextId: "ctx-copy", order: 1 },
      { contextId: "ctx-copy", order: 2 },
      { contextId: "ctx-preflight", order: 1 },
      { contextId: "ctx-closeout", order: 1 },
    ]);
  });

  it("gives a typed integration context its own authored contract instead of a prerequisite apology", () => {
    const { definition } = materialize();

    const closeout = definition.executionContexts.find(
      (context) => context.id === "ctx-closeout",
    );
    expect(closeout?.acceptanceCriteria).toBe(
      "The two delivery contexts compose through the production propose path.",
    );
    expect(stableStringify(definition)).not.toContain(
      "No selected criterion is directly mapped to this prerequisite task",
    );
  });

  it("never carries the legacy prerequisite apology in this code path", () => {
    const source = readFileSync(
      new URL("./delivery-plan-materializer.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("prerequisite task");
    expect(source).not.toContain("laneGroup");
  });

  it("copies task instructions and titles byte for byte", () => {
    const document = planDocument();
    const { definition } = materialize();

    for (const authored of document.tasks) {
      const compiled = definition.tasks.find(
        (task) => task.id === authored.taskId,
      );
      expect(compiled?.title).toBe(authored.title);
      expect(compiled?.instructions).toBe(authored.instructions);
    }
  });

  it("produces a definition the workflow schema accepts", () => {
    const { definition } = materialize();
    expect(() =>
      workflowSemanticDefinitionSchema.parse(definition),
    ).not.toThrow();
  });
});

/**
 * The authored document with one context's placement replaced. Written as a
 * whole-document reparse rather than a cast so an authored placement the schema
 * would refuse can never reach the materializer through a test.
 */
function withPlacements(
  placements: Readonly<Record<string, DeliveryPlanContextPlacement>>,
  base: DeliveryPlanDocument = planDocument(),
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...base,
    contexts: base.contexts.map((context) => {
      const placement = placements[context.contextId];
      return placement === undefined ? context : { ...context, placement };
    }),
  });
}

/** The authored document plus placement-less contexts with the given ids. */
function withExtraContexts(...contextIds: string[]): DeliveryPlanDocument {
  const base = planDocument();
  return deliveryPlanDocumentSchema.parse({
    ...base,
    contexts: [
      ...base.contexts,
      ...contextIds.map((contextId) => ({
        contextId,
        title: `Context ${contextId}`,
        contextType: "delivery",
        criterionElementIds: [],
        acceptanceContract: [`Context ${contextId} delivers its own work.`],
        proofPlan: [],
      })),
    ],
    tasks: [
      ...base.tasks,
      ...contextIds.map((contextId) => ({
        taskId: `task-${contextId}`,
        contextId,
        title: `Work of ${contextId}`,
        instructions: `Do the work ${contextId} owns.`,
        order: 0,
        contributesToCriterionElementIds: [],
      })),
    ],
  });
}

/**
 * The definition the materializer produced BEFORE placement was authorable:
 * every context took `{ lane: contextId, mode: "full" }` and nothing else in
 * the compile differed. Rebuilding it from today's output is what makes a hash
 * pin a comparison against the old code rather than against itself.
 */
function prePlacementCompile(
  definition: WorkflowSemanticDefinition,
): WorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) => ({
      ...context,
      placement: { lane: context.id, mode: "full" },
    })),
  };
}

/** The plan-identity inputs the fixture pins, so a hash pin reads as one call. */
function hashInput(document: DeliveryPlanDocument) {
  return {
    pinnedRevisionId: PINNED_REVISION_ID,
    draftRevision: materializationInput().draftRevision,
    document,
  };
}

function placementOf(
  materialization: DeliveryPlanMaterialization,
  contextId: string,
): unknown {
  return materialization.definition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement;
}

describe("materializeDeliveryPlan — placement", () => {
  it("copies an authored full placement field for field", () => {
    const placement: DeliveryPlanContextPlacement = {
      lane: "delivery",
      mode: "full",
    };
    const materialized = materialize(
      materializationInput({
        document: withPlacements({ "ctx-copy": placement }),
      }),
    );

    expect(placementOf(materialized, "ctx-copy")).toEqual(placement);
  });

  it("copies an authored owned placement field for field, every ownedPath included", () => {
    const copyPlacement: DeliveryPlanContextPlacement = {
      lane: "shared",
      mode: "owned",
      ownedPaths: ["src/lib/specs", "docs/design", "src/lib/state-store"],
    };
    const preflightPlacement: DeliveryPlanContextPlacement = {
      lane: "shared",
      mode: "owned",
      ownedPaths: ["src/cli"],
    };
    const materialized = materialize(
      materializationInput({
        document: withPlacements({
          "ctx-copy": copyPlacement,
          "ctx-preflight": preflightPlacement,
        }),
      }),
    );

    expect(placementOf(materialized, "ctx-copy")).toEqual(copyPlacement);
    expect(placementOf(materialized, "ctx-preflight")).toEqual(
      preflightPlacement,
    );
  });

  it("gives a context with no authored placement a solo lane at full access", () => {
    const materialized = materialize();

    expect(
      materialized.definition.executionContexts.map((context) => [
        context.id,
        context.placement,
      ]),
    ).toEqual([
      ["ctx-copy", { lane: "ctx-copy", mode: "full" }],
      ["ctx-preflight", { lane: "ctx-preflight", mode: "full" }],
      ["ctx-closeout", { lane: "ctx-closeout", mode: "full" }],
    ]);
  });

  it("renames the generated solo lane another context authored, rather than sharing it", () => {
    const materialized = materialize(
      materializationInput({
        document: withPlacements({
          "ctx-preflight": { lane: "ctx-closeout", mode: "full" },
        }),
      }),
    );

    // The author chose "ctx-closeout" for ctx-preflight, so the context that
    // would have generated that spelling is the one that moves.
    expect(placementOf(materialized, "ctx-preflight")).toEqual({
      lane: "ctx-closeout",
      mode: "full",
    });
    expect(placementOf(materialized, "ctx-closeout")).toEqual({
      lane: "ctx-closeout-2",
      mode: "full",
    });
  });

  it("never generates the reserved session lane for a context named after it", () => {
    const materialized = materialize(
      materializationInput({ document: withExtraContexts(SESSION_LANE_NAME) }),
    );

    expect(placementOf(materialized, SESSION_LANE_NAME)).toEqual({
      lane: `${SESSION_LANE_NAME}-2`,
      mode: "full",
    });
    expect(
      materialized.definition.executionContexts.map(
        (context) => context.placement.lane,
      ),
    ).not.toContain(SESSION_LANE_ID);
  });

  /**
   * These call the materializer DIRECTLY, on documents propose-time lint would
   * also refuse. That is the point: the backstop has to hold on its own, so
   * that a plan reaching materialization by any route — a lint rule that stops
   * mirroring a graph rule, a caller that skips the lint — still cannot store
   * a candidate the graph tier would refuse to launch.
   */
  it("refuses a candidate whose same-lane owners overlap with nothing ordering them", () => {
    const result = materializeDeliveryPlan(
      materializationInput({
        document: withPlacements({
          "ctx-copy": {
            lane: "shared",
            mode: "owned",
            ownedPaths: ["src/lib/specs"],
          },
          "ctx-preflight": {
            lane: "shared",
            mode: "owned",
            ownedPaths: ["src/lib/specs/delivery"],
          },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    const stated = result.refusal.unmetConditions.join("\n");
    expect(stated).toContain("placement-owned-paths-overlap");
    expect(stated).toContain("ctx-copy");
    expect(result.refusal.details?.contextIds).toEqual(["ctx-copy"]);
  });

  it("refuses a read-only placement independently of the propose-time lint", () => {
    const result = materializeDeliveryPlan(
      materializationInput({
        document: withPlacements({
          "ctx-preflight": { lane: "reader", mode: "readOnly" },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.unmetConditions.join("\n")).toContain(
      "placement-readonly-missing-output-schema",
    );
    expect(result.refusal.unmetConditions.join("\n")).toContain(
      "ctx-preflight",
    );
  });

  it("accepts the placements it materializes, so a stored candidate is launchable", () => {
    const result = materializeDeliveryPlan(
      materializationInput({
        document: withPlacements({
          "ctx-copy": {
            lane: "shared",
            mode: "owned",
            ownedPaths: ["src/lib/specs"],
          },
          "ctx-preflight": {
            lane: "shared",
            mode: "owned",
            ownedPaths: ["src/cli"],
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("publishes the placement mapping so `cctl spec schema guidance` teaches the default", () => {
    expect(DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS).toContainEqual({
      source: "contexts[].placement",
      target: "executionContexts[].placement",
      transformation:
        "copy when authored; solo lane (context id, full access) when absent",
    });
  });
});

describe("materializeDeliveryPlan — hash stability", () => {
  /**
   * A placement-less plan is every plan authored before placement existed, and
   * its identity is what an approval binds to. Both hashes are pinned against
   * the values the compile produced BEFORE the field was authorable, so a
   * future change to lane naming or to the compile cannot silently re-identify
   * a plan that was already launchable.
   *
   * The reconstruction below is what makes the literals a comparison against
   * the old code rather than against themselves: the pre-placement compile gave
   * every context `{ lane: contextId, mode: "full" }` and touched nothing else,
   * so rebuilding that definition from today's output and hashing it reproduces
   * exactly what the previous code path emitted.
   */
  it("pins a placement-less document's planHash and compiledDefinitionHash to their pre-placement values", () => {
    const { definition, planHash, compiledDefinitionHash } = materialize();

    expect(deliveryPlanCompiledHash(prePlacementCompile(definition))).toBe(
      compiledDefinitionHash,
    );

    expect(planHash).toBe(
      "sha256:f96dd8baca0b768b20c1591231c4903958a1f824c72e17353c9231d6b7719d92",
    );
    expect(compiledDefinitionHash).toBe(
      "sha256:39bccf23dd8935ab6be96af69b21a5dd90f3067dcf5ff73b7741a465be053ae3",
    );
  });

  /**
   * The whole class R2.1 protects, not just the fixture. A context id is any
   * non-empty string, but the lane grammar admits `_` and `.` as well as
   * alphanumerics — so a placement-less plan whose ids carry either compiled to
   * those lanes verbatim and was launchable. Every such document must keep the
   * hash it had, which means the solo default cannot encode an id the grammar
   * already accepts.
   */
  it.each([
    "ctx_extra",
    "ctx.extra",
    "v1.2_rc",
    "UPPER_case.mixed-1",
    "_leading-underscore",
  ])(
    "keeps the previously-launchable lane %j for a placement-less context",
    (contextId) => {
      const { definition, compiledDefinitionHash } = materialize(
        materializationInput({ document: withExtraContexts(contextId) }),
      );

      expect(
        definition.executionContexts.find((context) => context.id === contextId)
          ?.placement,
      ).toEqual({ lane: contextId, mode: "full" });
      // And the whole compiled document still hashes to what the pre-placement
      // code path produced for it — lane-for-lane, byte for byte.
      expect(deliveryPlanCompiledHash(prePlacementCompile(definition))).toBe(
        compiledDefinitionHash,
      );
    },
  );

  /**
   * The complement, and the reason the encoder still exists: an id the grammar
   * does NOT admit could never have compiled to a launchable definition, so
   * encoding it moves no previously-launchable hash and is what lets the
   * omit-placement path stay total over arbitrary context ids.
   */
  it("encodes a context id the lane grammar does not admit", () => {
    const materialized = materialize(
      materializationInput({ document: withExtraContexts("ctx extra") }),
    );

    expect(placementOf(materialized, "ctx extra")).toEqual({
      lane: laneNameFromId("ctx extra"),
      mode: "full",
    });
    expect(laneIdViolation(laneNameFromId("ctx extra"))).toBeNull();
  });

  /**
   * planHash is a function of the authored document alone, so it is stable
   * unconditionally — including for a plan the compile would refuse.
   */
  it("keeps planHash a function of the authored document, unmoved by the placement default", () => {
    const document = planDocument();
    const authored = withPlacements({
      "ctx-copy": { lane: "ctx-copy", mode: "full" },
    });

    // Authoring the very placement the default supplies is a different
    // document, so its hash MUST move: the default is applied at compile, never
    // written back into the plan.
    expect(deliveryPlanHash(hashInput(authored))).not.toBe(
      deliveryPlanHash(hashInput(document)),
    );
    expect(materialize().planHash).toBe(deliveryPlanHash(hashInput(document)));
  });
});

describe("materializeDeliveryPlan — determinism", () => {
  it("is byte-identical across two materializations of the same snapshot", () => {
    const first = materialize();
    const second = materialize();

    expect(stableStringify(first.definition)).toBe(
      stableStringify(second.definition),
    );
    expect(first.compiledDefinitionHash).toBe(second.compiledDefinitionHash);
  });

  it("changes the compiled hash when the authored document changes", () => {
    const document = planDocument();
    const edited = {
      ...document,
      contexts: document.contexts.map((context) =>
        context.contextId === "ctx-copy"
          ? {
              ...context,
              acceptanceContract: [
                ...context.acceptanceContract,
                "A third obligation the author added.",
              ],
            }
          : context,
      ),
    };

    expect(
      materialize(materializationInput({ document: edited }))
        .compiledDefinitionHash,
    ).not.toBe(materialize().compiledDefinitionHash);
  });
});
