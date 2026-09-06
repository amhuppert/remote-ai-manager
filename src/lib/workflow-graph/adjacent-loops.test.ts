import { describe, expect, it } from "vitest";
import {
  graphWorkflowContextEdgeSchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowLoopGroupSchema,
} from "./definition-schemas";
import { projectExecutionRoutes } from "./execution-routes";
import topology from "./fixtures/rare-earth-launch-topology.json";
import { loopInstanceId } from "./loop-resolver";
import {
  completeContext,
  context,
  executionFor,
  runPass,
  task,
  workerJudgeDefinition,
} from "./loop-test-fixtures";
import { routeVerdict } from "./route-projection";

const contexts = topology.executionContexts.map((entry) =>
  graphWorkflowExecutionContextDefinitionSchema.parse({
    ...context(entry.id),
    ...entry,
  }),
);
const edges = topology.edges.map((entry) =>
  graphWorkflowContextEdgeSchema.parse(entry),
);
const groups = topology.loopGroups.map((entry) =>
  graphWorkflowLoopGroupSchema.parse(entry),
);

function rareEarthDefinition() {
  return workerJudgeDefinition({
    executionContexts: contexts,
    tasks: contexts.map((entry) => task(`task-${entry.id}`, entry.id)),
    edges,
    loopGroups: groups,
  });
}

describe("adjacent loop approval boundaries", () => {
  it("conserves every archived authored edge with logical exits and pass-one entries", () => {
    const resolved = rareEarthDefinition();
    const expectedEdges = edges.map((entry) => {
      const source = groups.find((group) =>
        group.bodyContextIds.includes(entry.sourceContextId),
      );
      const target = groups.find((group) =>
        group.bodyContextIds.includes(entry.targetContextId),
      );
      const internal = source !== undefined && source.id === target?.id;
      return {
        ...entry,
        id: internal ? loopInstanceId(source.id, 1, entry.id) : entry.id,
        sourceContextId: internal
          ? loopInstanceId(source.id, 1, entry.sourceContextId)
          : entry.sourceContextId,
        targetContextId: target
          ? loopInstanceId(target.id, 1, entry.targetContextId)
          : entry.targetContextId,
      };
    });
    expect(resolved.edges).toHaveLength(edges.length);
    expect(resolved.edges).toEqual(expect.arrayContaining(expectedEdges));
  });

  it("keeps anchoring and implementation blocked until each upstream judge approves", () => {
    let execution = executionFor(rareEarthDefinition());
    execution = runPass(execution).execution;
    expect(
      groups.map((group) => execution.loopStates[group.id]?.activation),
    ).toEqual([undefined, undefined, undefined]);
    completeContext(execution, "explore-design", {
      mode: "normal",
      slug: "event-minerals",
      handoff: "ready",
    });
    execution = runPass(execution).execution;
    for (const [index, group] of groups.entries()) {
      expect(execution.loopStates[group.id]?.activation).toBe("running");
      for (const downstream of groups.slice(index + 1)) {
        expect(execution.loopStates[downstream.id]?.activation).toBeUndefined();
        expect(
          routeVerdict(
            projectExecutionRoutes(execution),
            loopInstanceId(downstream.id, 1, downstream.entryContextId),
          ).kind,
        ).toBe("waiting");
      }
      completeContext(
        execution,
        loopInstanceId(group.id, 1, group.entryContextId),
      );
      completeContext(
        execution,
        loopInstanceId(group.id, 1, group.exitContextId),
        {
          verdict: "changes-requested",
          handoff: "revise",
          ...(group.id === "unit-loop"
            ? { hasCodeConnectCandidates: false }
            : {}),
        },
      );
      execution = runPass(execution).execution;
      expect(execution.loopStates[group.id]?.activation).toBe("running");
      for (const downstream of groups.slice(index + 1)) {
        expect(execution.loopStates[downstream.id]?.activation).toBeUndefined();
      }
      completeContext(
        execution,
        loopInstanceId(group.id, 2, group.entryContextId),
      );
      completeContext(
        execution,
        loopInstanceId(group.id, 2, group.exitContextId),
        {
          verdict: group.id === "unit-loop" ? "all-units-approved" : "approved",
          handoff: "approved",
          ...(group.id === "unit-loop"
            ? { hasCodeConnectCandidates: false }
            : {}),
        },
      );
      execution = runPass(execution).execution;
      expect(execution.loopStates[group.id]?.activation).toBe("concluded");
    }
    expect(
      routeVerdict(projectExecutionRoutes(execution), "final-verification")
        .kind,
    ).toBe("eligible");
  });

  it("skips all three loops when the classification prerequisite is untaken", () => {
    let execution = executionFor(rareEarthDefinition());
    completeContext(execution, "explore-design", {
      mode: "screen-deck",
      slug: "deck",
      handoff: "report",
    });
    execution = runPass(execution).execution;
    expect(
      groups.map((group) => execution.loopStates[group.id]?.activation),
    ).toEqual(["skipped", "skipped", "skipped"]);
    for (const group of groups) {
      expect(execution.loopStates[group.id]?.slotLedger).toEqual([]);
      for (const id of group.bodyContextIds) {
        expect(
          execution.contextStates[loopInstanceId(group.id, 1, id)]?.status,
        ).toBe("skipped");
      }
    }
    expect(
      routeVerdict(projectExecutionRoutes(execution), "screen-deck-report")
        .kind,
    ).toBe("eligible");
  });
});
