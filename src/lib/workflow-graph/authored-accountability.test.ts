import { describe, expect, it } from "vitest";
import { collectStableAccountabilityContextIds } from "./authored-accountability";
import type { WorkflowSemanticDefinition } from "./definition-schemas";
import { createWorkflowDefinition } from "./test-fixtures";

const SHIP_GUARD = {
  schema: {
    type: "object",
    properties: { verdict: { const: "ship" } },
    required: ["verdict"],
  },
};

function definition(
  contextIds: readonly string[],
  edges: WorkflowSemanticDefinition["edges"],
  loopGroups?: ReadonlyArray<{
    id: string;
    bodyContextIds: string[];
    entryContextId: string;
    exitContextId: string;
  }>,
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  const context = base.executionContexts[0]!;
  return {
    ...base,
    executionContexts: contextIds.map((id) => ({ ...context, id })),
    tasks: [],
    edges,
    ...(loopGroups === undefined
      ? { loopGroups: undefined }
      : {
          loopGroups: loopGroups.map((group) => ({
            ...group,
            title: group.id,
            until: { schema: { type: "object" } },
            maxPasses: 2,
          })),
        }),
  };
}

function edge(
  sourceContextId: string,
  targetContextId: string,
  when?: WorkflowSemanticDefinition["edges"][number]["when"],
): WorkflowSemanticDefinition["edges"][number] {
  return {
    id: `${sourceContextId}__${targetContextId}`,
    sourceContextId,
    targetContextId,
    ...(when === undefined ? {} : { when }),
  };
}

describe("collectStableAccountabilityContextIds", () => {
  it("keeps every authored context in an unconditional chain stable", () => {
    expect(
      collectStableAccountabilityContextIds(
        definition(
          ["plan", "implement", "integrate"],
          [edge("plan", "implement"), edge("implement", "integrate")],
        ),
      ),
    ).toEqual(["plan", "implement", "integrate"]);
  });

  it("keeps guarded routes stable for group analysis", () => {
    expect(
      collectStableAccountabilityContextIds(
        definition(
          ["classify", "ship", "announce"],
          [edge("classify", "ship", SHIP_GUARD), edge("ship", "announce")],
        ),
      ),
    ).toEqual(["classify", "ship", "announce"]);
  });

  it("excludes loop body templates while retaining stable orchestration and post-loop integration", () => {
    expect(
      collectStableAccountabilityContextIds(
        definition(
          ["orchestrate", "loop-work", "loop-judge", "integrate"],
          [
            edge("orchestrate", "loop-work"),
            edge("loop-work", "loop-judge"),
            edge("loop-judge", "integrate"),
          ],
          [
            {
              id: "refine",
              bodyContextIds: ["loop-work", "loop-judge"],
              entryContextId: "loop-work",
              exitContextId: "loop-judge",
            },
          ],
        ),
      ),
    ).toEqual(["orchestrate", "integrate"]);
  });

  it("keeps an expansion-authorized authored spawner stable without inventing generated sources", () => {
    const input = definition(
      ["expand", "integrate"],
      [edge("expand", "integrate")],
    );
    input.executionContexts[0]!.mutability = {
      allowAgentTaskAdd: false,
      allowAgentContextAdd: true,
    };

    expect(collectStableAccountabilityContextIds(input)).toEqual([
      "expand",
      "integrate",
    ]);
  });

  it("keeps a post-branch integration source must-run when an unconditional route still reaches it", () => {
    expect(
      collectStableAccountabilityContextIds(
        definition(
          ["classify", "optional", "always", "integrate"],
          [
            edge("classify", "optional", SHIP_GUARD),
            edge("classify", "always"),
            edge("optional", "integrate"),
            edge("always", "integrate"),
          ],
        ),
      ),
    ).toEqual(["classify", "optional", "always", "integrate"]);
  });
});
