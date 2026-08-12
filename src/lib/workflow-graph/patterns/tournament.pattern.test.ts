import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { runEngineScenario } from "../compat/engine-harness";
import type { EngineScenarioRun } from "../compat/engine-harness";
import { resolveUpstreamInputs } from "../context-outputs";
import { workflowSemanticDefinitionSchema } from "../definition-schemas";

/**
 * Pattern proof: Tournament (D6 R2.5).
 *
 * The bracket itself is easy — four contenders, two semifinals, one final. What
 * is NOT free is the charter's `direct-predecessor-artifact-carrying`
 * invariant: upstream injection reaches a context's DIRECT predecessors only,
 * so by the time the final judge runs, the four contenders are two hops away
 * and their artifacts are gone. A semifinal that banks only a winner's
 * ID therefore hands the final a name it cannot evaluate.
 *
 * So the assertions here are in two halves: the topology, and the carrying —
 * each semifinal's output contract REQUIRES the winning artifact's content
 * alongside its identity, its task says so, and a real run shows the final
 * receiving both from its two direct predecessors and nothing from the
 * contenders.
 */

const PLAN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tournament.plan.json",
);

const CONTENDERS = [
  "context-contender-a",
  "context-contender-b",
  "context-contender-c",
  "context-contender-d",
] as const;
const SEMIFINALS = ["context-semifinal-ab", "context-semifinal-cd"] as const;
const FINAL = "context-final";

type Contender = (typeof CONTENDERS)[number];
type Semifinal = (typeof SEMIFINALS)[number];

/**
 * The engine hands hooks a plain `contextId`, so these guards are what let the
 * bracket tables below be keyed by the round a context is actually in: every
 * lookup is then total, and a table that fell out of step with the plan's ids
 * fails to compile rather than reading back `undefined` at runtime.
 */
function isContender(contextId: string): contextId is Contender {
  return (CONTENDERS as readonly string[]).includes(contextId);
}
function isSemifinal(contextId: string): contextId is Semifinal {
  return (SEMIFINALS as readonly string[]).includes(contextId);
}

/** Which contenders each semifinal judges, as the plan's edges declare it. */
const BRACKET: Record<Semifinal, readonly Contender[]> = {
  "context-semifinal-ab": ["context-contender-a", "context-contender-b"],
  "context-semifinal-cd": ["context-contender-c", "context-contender-d"],
};

/** The scripted contender artifacts — distinct, so a carried one is traceable. */
const ARTIFACT: Record<Contender, string> = {
  "context-contender-a": "Approach A: memoize at the projection boundary.",
  "context-contender-b": "Approach B: precompute on write.",
  "context-contender-c": "Approach C: stream and fold incrementally.",
  "context-contender-d": "Approach D: cache the whole materialized view.",
};

/** Who wins each semifinal in this scenario. */
const SEMIFINAL_WINNER: Record<Semifinal, Contender> = {
  "context-semifinal-ab": "context-contender-b",
  "context-semifinal-cd": "context-contender-c",
};

const CHAMPION: Contender = "context-contender-c";

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

async function runTournament<T>(
  inspect: (run: EngineScenarioRun) => Promise<T>,
): Promise<T> {
  return runEngineScenario(
    {
      name: "tournament",
      definition: planDefinition(),
      sessionLaneEnabled: false,
      agent: () => "complete-next-task",
      capture: ({ contextId }) => {
        if (isContender(contextId)) {
          return {
            approach: contextId.replace("context-contender-", "approach-"),
            artifact: ARTIFACT[contextId],
            rationale: `${contextId} argues for its own approach.`,
          };
        }
        if (isSemifinal(contextId)) {
          const winner = SEMIFINAL_WINNER[contextId];
          return {
            winnerContextId: winner,
            winningApproach: winner.replace("context-contender-", "approach-"),
            // The carrying the invariant demands: the semifinal copies the
            // winner's artifact forward, because the final cannot reach back.
            winningArtifact: ARTIFACT[winner],
            rationale: `${winner} beat its opponent on the brief's terms.`,
          };
        }
        if (contextId === FINAL) {
          return {
            championContextId: CHAMPION,
            championArtifact: ARTIFACT[CHAMPION],
            rationale: "The champion, compared against the other finalist.",
          };
        }
        return null;
      },
    },
    inspect,
  );
}

describe("Tournament, as an ordinary plan (D6 R2.5)", () => {
  it("is a four-to-two-to-one bracket of mechanically read-only judges", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);

    const definition = result.draft.definition;
    const byId = new Map(
      definition.executionContexts.map((context) => [context.id, context]),
    );
    expect([...byId.keys()].sort()).toEqual(
      [...CONTENDERS, ...SEMIFINALS, FINAL].sort(),
    );

    // Contenders and judges alike only emit output, so every one of them is
    // mechanically read-only — no worktree, no commit, nothing to merge.
    for (const contextId of [...CONTENDERS, ...SEMIFINALS, FINAL]) {
      expect(byId.get(contextId)?.placement).toEqual({
        lane: "session",
        mode: "readOnly",
      });
    }

    // The bracket, read off the edges rather than off the ids.
    for (const semifinal of SEMIFINALS) {
      expect(
        definition.edges
          .filter((edge) => edge.targetContextId === semifinal)
          .map((edge) => edge.sourceContextId)
          .sort(),
      ).toEqual([...BRACKET[semifinal]].sort());
    }
    expect(
      definition.edges
        .filter((edge) => edge.targetContextId === FINAL)
        .map((edge) => edge.sourceContextId)
        .sort(),
    ).toEqual([...SEMIFINALS].sort());
  });

  it("requires each semifinal to bank the winning artifact, not just the winner's name", () => {
    const result = validateWorkflowPlan(readPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const definition = result.draft.definition;
    for (const semifinal of SEMIFINALS) {
      const schema = definition.executionContexts.find(
        (context) => context.id === semifinal,
      )?.outputSchema as
        | { required?: unknown; properties?: Record<string, unknown> }
        | undefined;

      // Identity alone is the failure mode this invariant exists to prevent:
      // the final's direct predecessors are the semifinals, so an unforwarded
      // artifact is an artifact the final can never read.
      expect(schema?.required).toEqual(
        expect.arrayContaining(["winnerContextId", "winningArtifact"]),
      );
      expect(schema?.properties?.winningArtifact).toMatchObject({
        type: "string",
      });

      // And the task has to SAY so, or a real agent banks a citation.
      const instructions = definition.tasks.find(
        (task) => task.contextId === semifinal,
      )?.instructions;
      expect(instructions).toMatch(/winningArtifact/);
    }
  });

  it("runs the bracket and lets the final compare two semifinal winners it can actually read", async () => {
    await runTournament(async (run) => {
      const { settled } = run;
      expect(settled.status).toBe("completed");
      expect(settled.haltReason).toBeNull();

      // All four contenders ran independently, on no lane at all.
      for (const contender of CONTENDERS) {
        expect(settled.contextStates[contender]?.status).toBe("completed");
        expect(settled.contextStates[contender]?.laneId).toBeNull();
      }

      // The final's inputs are its DIRECT predecessors — the two semifinals —
      // and the contenders are not among them. That is the constraint the
      // carrying exists to work around, asserted rather than assumed.
      const finalInputs = resolveUpstreamInputs(settled, FINAL);
      expect(finalInputs.map((input) => input.contextId).sort()).toEqual(
        [...SEMIFINALS].sort(),
      );

      // Each carried its winner's artifact CONTENT through, so the final judged
      // two artifacts rather than two names.
      for (const semifinal of SEMIFINALS) {
        const carried = finalInputs.find(
          (input) => input.contextId === semifinal,
        );
        const winner = SEMIFINAL_WINNER[semifinal];
        expect(
          carried?.output,
          `the final received nothing from "${semifinal}"`,
        ).toMatchObject({
          winnerContextId: winner,
          winningArtifact: ARTIFACT[winner],
        });
      }

      // Exactly one champion, banked durably.
      expect(settled.contextOutputs[FINAL]?.value).toMatchObject({
        championContextId: CHAMPION,
        championArtifact: ARTIFACT[CHAMPION],
      });
      return null;
    });
  }, 60_000);
});
