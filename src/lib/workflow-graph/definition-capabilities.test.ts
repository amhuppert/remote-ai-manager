import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import { resolveWorkflowDefinition } from "./resolve-config";
import {
  workflowSemanticDefinitionSchema,
  type WorkflowSemanticDefinition,
} from "./definition-schemas";
import { createWorkflowDefinition } from "./test-fixtures";

describe("workflow definition capabilities", () => {
  it("round-trips approval and opaque definition/context origins through resolution", () => {
    const definitionOrigin = {
      sourceUri: "spec://native-sdd/revisions/7?scope=R17.3",
      label: "Native SDD revision 7",
    };
    const contextOrigin = {
      sourceUri: "custom-owner:tasks/T4.1#criteria=R17.3",
      label: "Task 4.1",
    };
    const base = createWorkflowDefinition();

    const parsed = workflowSemanticDefinitionSchema.parse({
      ...base,
      approvalRequired: true,
      origin: definitionOrigin,
      lockedRegions: [
        {
          paths: ["/tasks/task-plan-1/instructions"],
          sourceUri: "spec://native-sdd/revisions/7",
          reason: "Instructions are compiled from the approved plan",
        },
      ],
      executionContexts: base.executionContexts.map((context, index) =>
        index === 0 ? { ...context, origin: contextOrigin } : context,
      ),
    });

    expect(parsed.approvalRequired).toBe(true);
    expect(parsed.origin).toEqual(definitionOrigin);
    expect(parsed.executionContexts[0]?.origin).toEqual(contextOrigin);
    expect(parsed.lockedRegions).toEqual([
      {
        paths: ["/tasks/task-plan-1/instructions"],
        sourceUri: "spec://native-sdd/revisions/7",
        reason: "Instructions are compiled from the approved plan",
      },
    ]);

    const resolved = resolveWorkflowDefinition({} as GlobalConfig, parsed);
    expect(resolved.approvalRequired).toBe(true);
    expect(resolved.origin).toEqual(definitionOrigin);
    expect(resolved.executionContexts[0]?.origin).toEqual(contextOrigin);
    expect(resolved.lockedRegions).toEqual(parsed.lockedRegions);
  });

  it("parses legacy definitions without adding capability fields", () => {
    const legacy: WorkflowSemanticDefinition = createWorkflowDefinition();

    const parsed = workflowSemanticDefinitionSchema.parse(legacy);

    expect(parsed).not.toHaveProperty("approvalRequired");
    expect(parsed).not.toHaveProperty("origin");
    expect(parsed).not.toHaveProperty("lockedRegions");
    for (const context of parsed.executionContexts) {
      expect(context).not.toHaveProperty("origin");
    }
  });
});
