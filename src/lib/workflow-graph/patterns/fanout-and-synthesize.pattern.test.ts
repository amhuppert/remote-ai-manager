import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { structuralWarningsOf } from "./pattern-plan-warnings";
import { runEngineScenario } from "../compat/engine-harness";
import type { EngineScenarioRun } from "../compat/engine-harness";
import { resolveUpstreamInputs } from "../context-outputs";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import type { GraphWorkflowExecution } from "../schemas";

/**
 * Pattern proof: Fanout-And-Synthesize (D6 R2.2).
 *
 * The claim is the one D5 was built to make affordable: N independent readers
 * cost N agent turns, not N worktrees and N fan-in merges. So the load-bearing
 * assertions are all about what the run did NOT do — no reader worktree, no
 * reader landing commit, no reader join — alongside what it must do: dispatch
 * every reader in ONE eligible wave and put every reader's captured output in
 * front of the single synthesizer.
 *
 * The graph comes from the checked-in plan admitted through the production
 * authoring path, and everything that decides scheduling, lane assignment,
 * output injection and publication is production code. Only the agent turn, the
 * validator verdict and the git side effects are scripted, and none of them
 * decides a lane.
 */

const PLAN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fanout-and-synthesize.plan.json",
);

const READERS = [
  "context-read-runtime",
  "context-read-tests",
  "context-read-docs",
] as const;
const SYNTHESIZE = "context-synthesize";

function readPlan(): unknown {
  return JSON.parse(readFileSync(PLAN_PATH, "utf8"));
}

function planDefinition() {
  const plan = readPlan();
  const definition =
    typeof plan === "object" && plan !== null && "definition" in plan
      ? (plan as { definition: unknown }).definition
      : undefined;
  return workflowSemanticDefinitionSchema.parse(definition);
}

/** What each reader banks, so a synthesis can be checked for citing all of it. */
function readerFinding(contextId: string): Record<string, unknown> {
  return {
    area: contextId.replace("context-read-", ""),
    findings: [`${contextId} observed one thing worth reporting`],
    confidence: "medium",
  };
}

async function runFanout<T>(
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  return runEngineScenario(
    {
      name: "fanout-and-synthesize",
      definition: planDefinition(),
      // Deliberately OFF: the readers are authored onto the session lane as
      // read-only, and that placement is what makes them cheap. If they needed
      // the caller's session-worktree opt-in to run, the pattern would not be
      // expressible as an ordinary plan.
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      capture: ({ contextId }) => {
        if ((READERS as readonly string[]).includes(contextId)) {
          return readerFinding(contextId);
        }
        if (contextId === SYNTHESIZE) {
          return {
            synthesis:
              "One picture assembled from every reader's independent report.",
            citedContextIds: [...READERS],
          };
        }
        return null;
      },
    },
    inspect,
  );
}

function eligibleWaves(run: EngineScenarioRun): string[][] {
  return run.recording.scheduling.flatMap((decision) =>
    decision.decision === "eligible" ? [decision.contextIds] : [],
  );
}

function dispatchOrder(run: EngineScenarioRun): string[] {
  return run.recording.scheduling.flatMap((decision) =>
    decision.decision === "dispatched" ? [decision.contextId] : [],
  );
}

function joinsOf(settled: GraphWorkflowExecution) {
  return Object.values(settled.joins);
}

describe("Fanout-And-Synthesize, as an ordinary plan (D6 R2.2)", () => {
  it("places every reader read-only on the session lane and the synthesizer on the narrowest write lane", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(structuralWarningsOf(result.warnings)).toEqual([]);

    const contexts = result.draft.definition.executionContexts;
    const readers = contexts.filter((context) =>
      (READERS as readonly string[]).includes(context.id),
    );
    // At least three, because two agents disagreeing is a second opinion; the
    // pattern's claim is about a fan-out that a per-reader worktree would price
    // out of existence.
    expect(readers.length).toBeGreaterThanOrEqual(3);
    for (const reader of readers) {
      expect(reader.placement).toEqual({ lane: "session", mode: "readOnly" });
      // A read-only context's captured output IS its delivery, so a typed
      // contract is what makes the fan-out injectable rather than prose.
      expect(reader.outputSchema).toMatchObject({ type: "object" });
    }

    const synthesizer = contexts.find((context) => context.id === SYNTHESIZE);
    expect(synthesizer?.placement).toMatchObject({ mode: "owned" });
    expect(synthesizer?.placement?.lane).not.toBe("session");

    // Every reader feeds the one synthesizer, and nothing feeds a reader: the
    // readers are independent by construction, not by convention.
    const edges = result.draft.definition.edges;
    expect(
      edges
        .filter((edge) => edge.targetContextId === SYNTHESIZE)
        .map((edge) => edge.sourceContextId)
        .sort(),
    ).toEqual([...READERS].sort());
    expect(
      edges.filter((edge) =>
        (READERS as readonly string[]).includes(edge.targetContextId),
      ),
    ).toEqual([]);
  });

  it("dispatches every reader in one eligible wave and hands all of their outputs to the synthesizer", async () => {
    await runFanout(async (run) => {
      const { settled } = run;
      expect(settled.status).toBe("completed");
      expect(settled.haltReason).toBeNull();

      // ONE wave: the engine considered all three readers eligible together,
      // rather than releasing them one at a time behind a lane each.
      expect(eligibleWaves(run)[0]?.sort()).toEqual([...READERS].sort());

      // ...and the synthesizer ran after all of them, exactly once.
      const dispatched = dispatchOrder(run);
      expect(dispatched.filter((id) => id === SYNTHESIZE)).toHaveLength(1);
      for (const reader of READERS) {
        expect(dispatched.indexOf(reader)).toBeLessThan(
          dispatched.indexOf(SYNTHESIZE),
        );
      }

      // Every reader's captured output reached the synthesizer — the pattern's
      // whole point, and the thing a dropped reader would silently break.
      const upstream = resolveUpstreamInputs(settled, SYNTHESIZE);
      expect(upstream.map((input) => input.contextId).sort()).toEqual(
        [...READERS].sort(),
      );
      for (const input of upstream) {
        expect(input.output).toEqual(readerFinding(input.contextId));
      }

      // The synthesis cites all of them, and it is durable.
      expect(settled.contextOutputs[SYNTHESIZE]?.value).toMatchObject({
        citedContextIds: [...READERS],
      });
      return null;
    });
  }, 60_000);

  it("gives the readers no worktree, no landing commit and no join", async () => {
    await runFanout(async (run) => {
      const { settled } = run;

      for (const reader of READERS) {
        expect(settled.contextStates[reader]?.status).toBe("completed");
        // No lane at all: a session reader resolves through the sentinel ahead
        // of any lane-row lookup, so it never provisions a worktree.
        expect(settled.contextStates[reader]?.laneId).toBeNull();
        expect(settled.executionLanes[reader]).toBeUndefined();
      }

      // Nothing was merged on a reader's behalf. The only join is the final
      // publish of the synthesizer's lane.
      const joins = joinsOf(settled);
      expect(joins.map((join) => join.kind)).toEqual(["final_publish"]);
      const publish = joins[0];
      expect(publish?.status).toBe("succeeded");
      for (const reader of READERS) {
        expect(publish?.sourceLaneIds).not.toContain(reader);
      }
      expect(publish?.sourceLaneIds).toEqual([
        settled.contextStates[SYNTHESIZE]?.laneId,
      ]);
      return null;
    });
  }, 60_000);
});
