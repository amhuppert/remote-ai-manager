import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stableStringify } from "@/lib/state-store/serialization";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  ACCEPTANCE_CONTRACT_SERIALIZATION,
  deliveryPlanCharter,
  materializeDeliveryPlan,
  type DeliveryPlanMaterialization,
} from "./delivery-plan-materializer";
import {
  materializationInput,
  planDocument,
} from "./delivery-plan-materializer.fixture";

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
