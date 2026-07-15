/**
 * Drift detector for the workflow visualizations.
 *
 * Pins the introspection output of every live machine so that adding,
 * renaming, or removing a state/actor/guard/action in the source machine
 * surfaces here instead of silently going out of sync with the visualization.
 * It also asserts every introspected name has hand-typed metadata in
 * machine-specs.ts, and flags any orphan metadata keys.
 */

import { describe, it, expect } from "vitest";
import { and, setup } from "xstate";

import { conversationMachine } from "@/lib/workflows/conversation/machine";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import { commitMachine } from "@/lib/workflows/commit/machine";

import { introspectMachine } from "./machine-introspection";
import { machineSpecs, getMachineSpec } from "./machine-specs";

const machineFixtures = {
  conversation: conversationMachine,
  "smart-merge": mergeMachine,
  "smart-commit": commitMachine,
} as const;

describe("introspectMachine", () => {
  it("conversation: state ids are dot-qualified and ordered as authored", () => {
    const result = introspectMachine(conversationMachine);
    expect(result.machineId).toBe("conversation");
    expect(result.initialState).toBe("idle");
    expect(result.states.map((s) => s.id)).toEqual([
      "idle",
      "externalExecuting",
      "acquiringResources",
      "executing",
      "executing.dispatching",
      "executing.conversationTurn",
      "executing.taskRun",
      "finalizingTurn",
      "waitingForInput",
      "debug",
    ]);
    expect(result.actors).toEqual([
      "executePrompt",
      "prepareTurn",
      "runTaskRun",
    ]);
  });

  it("composite guard renders as 'a && b'", () => {
    const compositeMachine = setup({
      guards: {
        first: () => true,
        second: () => true,
      },
    }).createMachine({
      id: "composite",
      initial: "start",
      states: {
        start: {
          on: {
            GO: { guard: and(["first", "second"]), target: "done" },
          },
        },
        done: {},
      },
    });
    const result = introspectMachine(compositeMachine);
    const start = result.states.find((s) => s.id === "start");
    const composite = start?.events.find((e) => e.guard === "first && second");
    expect(composite).toBeDefined();
    expect(composite?.target).toBe("done");
  });

  it("conversation: parentId is set on nested states", () => {
    const result = introspectMachine(conversationMachine);
    const conversationTurn = result.states.find(
      (s) => s.id === "executing.conversationTurn",
    );
    expect(conversationTurn?.parentId).toBe("executing");
    const taskRun = result.states.find((s) => s.id === "executing.taskRun");
    expect(taskRun?.parentId).toBe("executing");
  });

  it("conversation: absolute target '#conversation.x' resolves to 'x'", () => {
    const result = introspectMachine(conversationMachine);
    const conversationTurn = result.states.find(
      (s) => s.id === "executing.conversationTurn",
    );
    expect(
      conversationTurn?.events.find((e) => e.event === "onDone")?.target,
    ).toBe("finalizingTurn");
    // ASK_QUESTION is an internal transition — no target.
    expect(
      conversationTurn?.events.find((e) => e.event === "ASK_QUESTION")?.target,
    ).toBeUndefined();
  });

  it("smart-merge: kind classification (transient vs atomic vs final)", () => {
    const result = introspectMachine(mergeMachine);
    expect(result.machineId).toBe("smartMerge");
    expect(result.initialState).toBe("entryRouting");
    const byId = new Map(result.states.map((s) => [s.id, s]));
    expect(byId.get("entryRouting")?.kind).toBe("transient");
    expect(byId.get("verifyingBranch")?.kind).toBe("atomic");
    expect(byId.get("routing")?.kind).toBe("transient");
    expect(byId.get("conflictsDetected")?.kind).toBe("transient");
    expect(byId.get("checkingUncommitted")?.kind).toBe("atomic");
    expect(byId.get("preparing")?.kind).toBe("atomic");
    expect(byId.get("publishing")?.kind).toBe("atomic");
    expect(byId.get("discarding")?.kind).toBe("atomic");
    expect(byId.get("completed")?.kind).toBe("final");
    expect(byId.get("failed")?.kind).toBe("final");
    expect(byId.get("conflicts")?.kind).toBe("final");
    expect(byId.get("readyToLand")?.kind).toBe("final");
    expect(byId.get("discarded")?.kind).toBe("final");
  });

  it("smart-merge: invokes are extracted per state", () => {
    const result = introspectMachine(mergeMachine);
    const byId = new Map(result.states.map((s) => [s.id, s]));
    expect(byId.get("checkingUncommitted")?.invokes).toEqual([
      "checkUncommitted",
    ]);
    expect(byId.get("mergingMain")?.invokes).toEqual(["mergeMain"]);
    expect(byId.get("preparing")?.invokes).toEqual(["prepare"]);
    expect(byId.get("publishing")?.invokes).toEqual(["publish"]);
    expect(byId.get("discarding")?.invokes).toEqual(["discardParkedRef"]);
  });
});

describe("machine-specs metadata coverage", () => {
  for (const id of ["conversation", "smart-merge", "smart-commit"] as const) {
    describe(id, () => {
      const spec = getMachineSpec(id);
      const machine = machineFixtures[id];
      const introspected = introspectMachine(machine);

      it("registers a description for every introspected actor", () => {
        const undescribed = spec.actors
          .filter((a) => a.description === "")
          .map((a) => a.name);
        expect(undescribed).toEqual([]);
      });

      it("registers a description for every introspected guard", () => {
        const undescribed = spec.guards
          .filter((g) => g.description === "")
          .map((g) => g.name);
        expect(undescribed).toEqual([]);
      });

      it("registers a description for every introspected action", () => {
        const undescribed = spec.actions
          .filter((a) => a.description === "")
          .map((a) => a.name);
        expect(undescribed).toEqual([]);
      });

      it("merged spec actor names match the introspected machine", () => {
        expect(spec.actors.map((a) => a.name)).toEqual(introspected.actors);
      });

      it("merged spec guard names match the introspected machine", () => {
        expect(spec.guards.map((g) => g.name)).toEqual(introspected.guards);
      });

      it("merged spec action names match the introspected machine", () => {
        expect(spec.actions.map((a) => a.name)).toEqual(introspected.actions);
      });

      it("merged spec state ids match the introspected machine", () => {
        expect(spec.states.map((s) => s.id)).toEqual(
          introspected.states.map((s) => s.id),
        );
      });
    });
  }

  it("the registry has all 3 machines", () => {
    expect(machineSpecs.map((s) => s.id)).toEqual([
      "conversation",
      "smart-merge",
      "smart-commit",
    ]);
  });
});
