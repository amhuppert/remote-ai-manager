import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  WorkflowPrerequisite,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

import {
  createPrerequisiteProbes,
  type PrerequisiteProbes,
  type ProbeOutcome,
} from "./prerequisite-probes";

const logger = createLogger("workflow-graph.preflight-prerequisite-service");

// A single itemized prerequisite miss. `reason` carries the probe outcome:
// "absent" (definitively missing) vs "probe_error" (could not be evaluated —
// still fails closed, R5.10). For a backend-unscoped skill, `backend` is null
// to signal "unmet on at least one used backend" rather than scoped to one.
export type MissingPrerequisite =
  | {
      kind: "path";
      path: string;
      label: string | null;
      reason: "absent" | "probe_error";
    }
  | {
      kind: "skill";
      skill: string;
      backend: AgentBackendId | null;
      label: string | null;
      reason: "absent" | "probe_error";
    };

export interface PreflightPrerequisiteService {
  // Deterministically evaluates the definition's declared prerequisites against
  // the target worktree, mirroring the runtime skill-discovery of the backends
  // the resolved workflow uses. Report-only — composes the read-only probes and
  // itemizes misses; never installs/creates/infers/remediates (R5.8).
  evaluate(input: {
    definition: WorkflowSemanticDefinition;
    worktreePath: string;
    // The SET of backends the resolved workflow actually uses (R5.2a). Computed
    // by the start gate from the config cascade, not here.
    usedBackends: ReadonlySet<AgentBackendId>;
  }): Promise<
    | { status: "ok" }
    | { status: "prerequisites_unmet"; missing: MissingPrerequisite[] }
  >;
}

// Method syntax (bivariant) so the production `createPrerequisiteProbes` result
// assigns cleanly to this slot without contravariance friction.
export interface PreflightPrerequisiteServiceDeps {
  probes?: PrerequisiteProbes;
}

function labelOf(prerequisite: WorkflowPrerequisite): string | null {
  return prerequisite.label ?? null;
}

// Aggregates per-backend skill outcomes for a backend-unscoped skill into a
// single satisfied/reason verdict. Satisfied ONLY when every used backend is
// satisfied (R5.2a/R5.4a) — a single-backend pass would false-pass a capability
// the run actually needs on another backend. Fails closed: a probe_error on any
// backend outranks an absent so the aggregate reason surfaces the worst case.
function aggregateBackendOutcomes(
  outcomes: ProbeOutcome[],
):
  | { satisfied: true }
  | { satisfied: false; reason: "absent" | "probe_error" } {
  if (outcomes.every((outcome) => outcome.satisfied)) {
    return { satisfied: true };
  }
  const anyProbeError = outcomes.some(
    (outcome) => !outcome.satisfied && outcome.reason === "probe_error",
  );
  return {
    satisfied: false,
    reason: anyProbeError ? "probe_error" : "absent",
  };
}

export function createPreflightPrerequisiteService(
  deps: PreflightPrerequisiteServiceDeps = {},
): PreflightPrerequisiteService {
  const probes = deps.probes ?? createPrerequisiteProbes();

  return {
    async evaluate({ definition, worktreePath, usedBackends }) {
      const { prerequisites } = definition;
      // Empty prerequisites short-circuit with NO probing (R5.7).
      if (prerequisites.length === 0) {
        return { status: "ok" };
      }

      const missing: MissingPrerequisite[] = [];

      for (const prerequisite of prerequisites) {
        const label = labelOf(prerequisite);

        if (prerequisite.kind === "path") {
          // A path prerequisite is backend-independent — probe once (R5.3).
          const outcome = await probes.probePath({
            worktreePath,
            path: prerequisite.path,
          });
          if (!outcome.satisfied) {
            missing.push({
              kind: "path",
              path: prerequisite.path,
              label,
              reason: outcome.reason,
            });
          }
          continue;
        }

        if (prerequisite.backend) {
          // A backend-scoped skill is evaluated ONLY against its backend
          // (R5.4b) — never the used-backend set.
          const outcome = await probes.probeSkill({
            worktreePath,
            skill: prerequisite.skill,
            backend: prerequisite.backend,
          });
          if (!outcome.satisfied) {
            missing.push({
              kind: "skill",
              skill: prerequisite.skill,
              backend: prerequisite.backend,
              label,
              reason: outcome.reason,
            });
          }
          continue;
        }

        // A backend-unscoped skill is satisfied ONLY when the same normalized
        // reference discovers on EVERY used backend (R5.2a/R5.4a). An empty
        // used-backend set has no backend to satisfy on, so it is treated as
        // unmet (`absent`) rather than vacuously satisfied — fail-safe and
        // consistent with "satisfied only on every used backend". In practice
        // the start gate always passes a non-empty set (every context has an
        // implementer), so this is a defensive floor, not a live path.
        const outcomes: ProbeOutcome[] = [];
        for (const backend of usedBackends) {
          outcomes.push(
            await probes.probeSkill({
              worktreePath,
              skill: prerequisite.skill,
              backend,
            }),
          );
        }

        const aggregate =
          outcomes.length === 0
            ? ({ satisfied: false, reason: "absent" } as const)
            : aggregateBackendOutcomes(outcomes);

        if (!aggregate.satisfied) {
          missing.push({
            kind: "skill",
            skill: prerequisite.skill,
            backend: null,
            label,
            reason: aggregate.reason,
          });
        }
      }

      if (missing.length === 0) {
        return { status: "ok" };
      }

      logger.info("preflight.prerequisites_unmet", {
        worktreePath,
        missingCount: missing.length,
      });
      return { status: "prerequisites_unmet", missing };
    },
  };
}
