import {
  createConfigCascade,
  CONFIG_PATH_GRANULARITY,
  type ConfigCascade,
  type ConfigPath,
} from "@/components/workflow-config-panel/config-cascade";
import type { ConfigRowProvenance } from "@/components/workflow-config-panel/row-provenance";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { LiveConfigProvenance } from "./live-context-draft";

/**
 * The cascade the config panel reads when it is mounted over a LIVE execution.
 *
 * A launched execution runs a snapshotted resolved context: every block already
 * holds a concrete value, and the live-edit vocabulary has no clear-to-inherit
 * spelling at all — its config fields are plain optionals, so there is no way to
 * ask the engine to drop back to a tier above. Two consequences shape this
 * adapter:
 *
 * - **Nothing is ever "set here."** `own` is false for every path, so no row
 *   wears the cyan edge and none offers a reset the endpoint could not honour.
 * - **Provenance is proven, never inferred.** The seed records a source for
 *   collaboration (per field), agent validation (per role) and the script
 *   command selection; those are reported. Every other block resolves as the
 *   context's own value rather than a tier guessed by comparing it against
 *   today's global defaults, which a live execution has long since stopped
 *   reading.
 *
 * Resolution and intent construction are delegated to the canonical cascade over
 * the draft itself: the draft carries every block concretely, so the resolver's
 * answer for each path is the draft's own value and the global tier it is handed
 * can never surface.
 */

export function createLiveConfigCascade({
  context,
  provenance,
}: {
  context: GraphWorkflowExecutionContextDefinition;
  provenance: LiveConfigProvenance;
}): ConfigCascade {
  const base = createConfigCascade({
    scope: "context",
    globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig: {},
    context,
  });

  const rowProvenance = (path: ConfigPath): ConfigRowProvenance => ({
    sourceTier: provenance[path] ?? "context",
    scopeTier: "context",
    granularity: CONFIG_PATH_GRANULARITY[path],
    setHere: false,
  });

  return {
    scope: base.scope,
    paths: base.paths,
    resolve: (path) => ({
      value: base.resolve(path).value,
      sourceTier: provenance[path] ?? "context",
    }),
    own: () => false,
    counts: () => ({ block: 0, role: 0, field: 0 }),
    provenance: rowProvenance,
    groupProvenance(group) {
      const first = group[0];
      return first === undefined
        ? {
            sourceTier: "global",
            scopeTier: "context",
            granularity: "block",
            setHere: false,
          }
        : rowProvenance(first);
    },
    set: (path, value) => base.set(path, value),
    reset: (path) => base.reset(path),
    resetAll: () => base.resetAll(),
  };
}
