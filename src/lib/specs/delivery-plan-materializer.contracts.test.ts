import { describe, expect, it } from "vitest";
import {
  CONTEXT_PACK_MAX_BYTES,
  deliveryPlanMaterializationCriteria,
  materializeDeliveryPlan,
  readDeliveryPlanSourceMap,
  type DeliveryPlanMaterializationInput,
} from "./delivery-plan-materializer";
import {
  materializationInput,
  planCriteria,
  planDocument,
  pinnedRevisionSnapshot,
} from "./delivery-plan-materializer.fixture";
import type { DeliveryPlanDocument } from "./delivery-plan";
import { parseElementHandle } from "./handles";

function refusalOf(input: DeliveryPlanMaterializationInput) {
  const result = materializeDeliveryPlan(input);
  if (result.ok) {
    throw new Error("expected materialization to refuse, but it compiled");
  }
  return result.refusal;
}

function valueOf(input: DeliveryPlanMaterializationInput) {
  const result = materializeDeliveryPlan(input);
  if (!result.ok) {
    throw new Error(`expected success, refused: ${result.refusal.instruction}`);
  }
  return result.value;
}

describe("materializeDeliveryPlan — source-map round trip", () => {
  it("maps every authored task, context, criterion, and edge back out of the definition", () => {
    const document = planDocument();
    const { definition } = valueOf(materializationInput());

    const sourceMap = readDeliveryPlanSourceMap(definition);

    expect(sourceMap.attemptId).toBe("attempt-materializer");
    expect(sourceMap.pinnedRevisionId).toBe("revision-materializer-2");
    expect(sourceMap.contexts.map((entry) => entry.contextId).sort()).toEqual(
      document.contexts.map((context) => context.contextId).sort(),
    );
    expect(sourceMap.tasks.map((entry) => entry.taskId).sort()).toEqual(
      document.tasks.map((task) => task.taskId).sort(),
    );
    expect(sourceMap.edges.map((entry) => entry.edgeId).sort()).toEqual(
      document.edges.map((edge) => edge.edgeId).sort(),
    );
    expect(
      sourceMap.contexts.flatMap((entry) => entry.criterionElementIds).sort(),
    ).toEqual(
      document.contexts
        .flatMap((context) => context.criterionElementIds)
        .sort(),
    );
  });

  it("carries each edge under the context it targets, with its authored source", () => {
    const { definition } = valueOf(materializationInput());

    const sourceMap = readDeliveryPlanSourceMap(definition);
    expect(sourceMap.edges).toEqual([
      {
        edgeId: "edge-copy-to-closeout",
        fromContextId: "ctx-copy",
        toContextId: "ctx-closeout",
      },
      {
        edgeId: "edge-preflight-to-closeout",
        fromContextId: "ctx-preflight",
        toContextId: "ctx-closeout",
      },
    ]);
  });

  it("refuses to read a source map from a definition that carries none", () => {
    const { definition } = valueOf(materializationInput());
    const stripped = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) => ({
        ...context,
        metadata: undefined,
      })),
    };

    expect(() => readDeliveryPlanSourceMap(stripped)).toThrow(/ctx-copy/);
  });
});

describe("deliveryPlanMaterializationCriteria — what the pinned revision says", () => {
  it("addresses every criterion by the handle the rest of the spec surfaces use", () => {
    const criteria = deliveryPlanMaterializationCriteria(
      pinnedRevisionSnapshot(),
    );

    expect(
      criteria.map(({ criterionElementId, handle, text }) => ({
        criterionElementId,
        handle,
        text,
      })),
    ).toEqual([
      {
        criterionElementId: "criterion-copy",
        handle: "R1.1",
        text: "The materializer copies the authored acceptance contract verbatim.",
      },
      {
        criterionElementId: "criterion-determinism",
        handle: "R1.2",
        text: "Materializing the same snapshot twice is byte-identical.",
      },
      {
        criterionElementId: "criterion-preflight",
        handle: "R2.1",
        text: "An unknown registered validation command refuses before persistence.",
      },
    ]);
    // A pack quotes these handles at an implementer, who addresses the
    // criterion with them: an unparseable handle is an unaddressable criterion.
    for (const criterion of criteria) {
      expect(() =>
        parseElementHandle(criterion.handle, "exact-materialization"),
      ).not.toThrow();
    }
  });

  it("carries the approved validation strategy and skips every non-criterion element", () => {
    const criteria = deliveryPlanMaterializationCriteria(
      pinnedRevisionSnapshot(),
    );

    expect(criteria).toHaveLength(3);
    expect(criteria[2]?.validationStrategy).toEqual({
      kinds: ["test_run", "validator_verdict"],
      note: "One failing case per refusal class.",
    });
  });

  it("falls back to the element id when the revision allocated no number", () => {
    const snapshot = pinnedRevisionSnapshot();
    const unnumbered = {
      ...snapshot,
      elements: snapshot.elements.map((row) =>
        row.element.id === "criterion-preflight"
          ? { ...row, element: { ...row.element, number: null } }
          : row,
      ),
    };

    expect(
      deliveryPlanMaterializationCriteria(unnumbered).map(
        (criterion) => criterion.handle,
      ),
    ).toEqual(["R1.1", "R1.2", "criterion-preflight"]);
  });
});

describe("materializeDeliveryPlan — context pack bound", () => {
  function documentWithLongCriteria(count: number): {
    document: DeliveryPlanDocument;
    criteria: ReturnType<typeof planCriteria>;
  } {
    const base = planDocument();
    const criterionIds = Array.from(
      { length: count },
      (_, index) => `criterion-bulk-${String(index).padStart(3, "0")}`,
    );
    return {
      document: {
        ...base,
        dispositions: criterionIds.map((criterionElementId) => ({
          criterionElementId,
          disposition: "selected" as const,
          deliveredByExecutionId: null,
          reaffirmation: null,
          note: null,
        })),
        contexts: [
          {
            ...base.contexts[0]!,
            criterionElementIds: criterionIds,
            proofPlan: [],
          },
        ],
        tasks: base.tasks
          .filter((task) => task.contextId === "ctx-copy")
          .map((task) => ({ ...task, contributesToCriterionElementIds: [] })),
        edges: [],
        wiring: [],
      },
      criteria: criterionIds.map((criterionElementId, index) => ({
        criterionElementId,
        handle: `bulk/C${index}`,
        text: "x".repeat(1000),
        validationStrategy: { kinds: ["validator_verdict" as const] },
      })),
    };
  }

  it("keeps every context pack inside the byte bound and reports what it cost", () => {
    const { document, criteria } = documentWithLongCriteria(200);

    const { definition, packManifests } = valueOf(
      materializationInput({ document, criteria }),
    );

    const pack = definition.executionContexts[0]?.description ?? "";
    expect(Buffer.byteLength(pack, "utf8")).toBeLessThanOrEqual(
      CONTEXT_PACK_MAX_BYTES,
    );
    const manifest = packManifests[0];
    expect(manifest?.total).toBe(200);
    expect(manifest?.omitted).toBeGreaterThan(0);
    expect(manifest?.included).toBe(manifest!.total - manifest!.omitted);
    expect(pack).toContain(
      `${manifest?.total} owned criteria, ${manifest?.included} included, ${manifest?.omitted} omitted`,
    );
  });

  it("truncates deterministically", () => {
    const { document, criteria } = documentWithLongCriteria(200);
    const input = () => materializationInput({ document, criteria });

    expect(valueOf(input()).definition.executionContexts[0]?.description).toBe(
      valueOf(input()).definition.executionContexts[0]?.description,
    );
    expect(valueOf(input()).packManifests).toEqual(
      valueOf(input()).packManifests,
    );
  });

  it("reports zero omitted when the whole pack fits", () => {
    const { packManifests } = valueOf(materializationInput());
    expect(packManifests.map((manifest) => manifest.omitted)).toEqual([
      0, 0, 0,
    ]);
    expect(packManifests.map((manifest) => manifest.contextId)).toEqual([
      "ctx-copy",
      "ctx-preflight",
      "ctx-closeout",
    ]);
  });
});

describe("materializeDeliveryPlan — refusals name their remedy", () => {
  it("refuses a criterion the pinned revision does not carry", () => {
    const document = planDocument();
    const dangling: DeliveryPlanDocument = {
      ...document,
      contexts: document.contexts.map((context) =>
        context.contextId === "ctx-copy"
          ? {
              ...context,
              criterionElementIds: [
                ...context.criterionElementIds,
                "criterion-ghost",
              ],
            }
          : context,
      ),
    };

    const refusal = refusalOf(materializationInput({ document: dangling }));
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions.join(" ")).toContain("criterion-ghost");
    expect(refusal.instruction).toContain("cctl spec plan edit");
  });

  it("refuses an edge that names a context the plan does not carry", () => {
    const document = planDocument();
    const dangling: DeliveryPlanDocument = {
      ...document,
      edges: [
        ...document.edges,
        {
          edgeId: "edge-ghost",
          fromContextId: "ctx-copy",
          toContextId: "ctx-missing",
        },
      ],
    };

    const refusal = refusalOf(materializationInput({ document: dangling }));
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions.join(" ")).toContain("ctx-missing");
  });

  it("refuses a task that names a context the plan does not carry", () => {
    const document = planDocument();
    const dangling: DeliveryPlanDocument = {
      ...document,
      tasks: [
        ...document.tasks,
        {
          taskId: "task-ghost",
          contextId: "ctx-missing",
          title: "Orphan",
          instructions: "Nothing owns this.",
          order: 0,
          contributesToCriterionElementIds: [],
        },
      ],
    };

    const refusal = refusalOf(materializationInput({ document: dangling }));
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions.join(" ")).toContain("task-ghost");
  });

  it("refuses a duplicate authored id rather than compiling one node twice", () => {
    const document = planDocument();
    const duplicated: DeliveryPlanDocument = {
      ...document,
      contexts: [...document.contexts, document.contexts[0]!],
    };

    const refusal = refusalOf(materializationInput({ document: duplicated }));
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions.join(" ")).toContain("ctx-copy");
  });

  it("refuses an unknown registered validation command name", () => {
    const document = planDocument();
    const unknown: DeliveryPlanDocument = {
      ...document,
      governance: {
        ...document.governance,
        validationCommandNames: ["typecheck", "smoke-suite"],
      },
    };

    const refusal = refusalOf(materializationInput({ document: unknown }));
    expect(refusal.code).toBe("dangling_reference");
    expect(refusal.unmetConditions.join(" ")).toContain("smoke-suite");
    expect(refusal.instruction).toContain("format, lint, typecheck");
    expect(refusal.instruction).toContain("cctl validate list");
  });

  it("refuses a plan whose governance cannot compile a charter", () => {
    const document = planDocument();
    const missionless: DeliveryPlanDocument = {
      ...document,
      governance: { ...document.governance, mission: "  " },
    };

    const refusal = refusalOf(materializationInput({ document: missionless }));
    expect(refusal.instruction).toContain("governance.mission");
  });
});

describe("materializeDeliveryPlan — pinned defaults and locked regions", () => {
  it("pins the resolved defaults so a later global change cannot move the candidate", () => {
    const pinned = valueOf(materializationInput());

    const laterDefaults = valueOf(
      materializationInput({
        defaults: {
          approvalRequired: false,
          workflowConfig: {
            mutability: {
              allowAgentTaskAdd: true,
              allowAgentContextAdd: false,
            },
            agentValidation: {
              implementer: { mode: "only", commands: ["lint"] },
              contextValidator: { mode: "all", except: [] },
            },
          },
        },
      }),
    );

    expect(pinned.definition.approvalRequired).toBe(true);
    expect(pinned.definition.workflowConfig.mutability).toEqual({
      allowAgentTaskAdd: false,
      allowAgentContextAdd: false,
    });
    expect(pinned.compiledDefinitionHash).not.toBe(
      laterDefaults.compiledDefinitionHash,
    );
  });

  it("resolves the authored command selection into the pinned candidate", () => {
    const { definition } = valueOf(materializationInput());

    expect(definition.workflowConfig.agentValidation?.contextValidator).toEqual(
      {
        mode: "only",
        commands: ["typecheck", "test"],
      },
    );
  });

  it("declares locked regions over the charter, contexts, tasks, and edges", () => {
    const document = planDocument();
    const { definition } = valueOf(materializationInput());
    const paths = (definition.lockedRegions ?? []).flatMap(
      (region) => region.paths,
    );

    expect(paths).toContain("/charter");
    for (const context of document.contexts) {
      expect(paths).toContain(
        `/executionContexts/${context.contextId}/acceptanceCriteria`,
      );
      expect(paths).toContain(`/executionContexts/${context.contextId}/title`);
    }
    for (const task of document.tasks) {
      expect(paths).toContain(`/tasks/${task.taskId}/instructions`);
      expect(paths).toContain(`/tasks/${task.taskId}/order`);
    }
    for (const edge of document.edges) {
      expect(paths).toContain(`/edges/${edge.edgeId}/targetContextId`);
    }
    expect(paths).toEqual(
      expect.arrayContaining([
        "/executionContexts/*",
        "/tasks/*",
        "/edges/*",
        "/workflowConfig",
        "/laneMergeValidation",
      ]),
    );
    expect(
      (definition.lockedRegions ?? []).every(
        (region) =>
          region.instruction?.includes(
            "cctl spec plan reopen exact-materialization",
          ) === true && !region.instruction.includes("<slug>"),
      ),
    ).toBe(true);
  });
});
