import type { PerRepoConfig } from "@/lib/config/schemas";
import type { GraphWorkflowLaneMergeValidationConfig } from "./config-schemas";
import type { RunMergeValidationMode } from "@/lib/workflows/validation-fix/types";

export type ReadLaneMergeRepoConfig = (
  projectPath: string,
) => Promise<PerRepoConfig | null>;

export async function resolveLaneMergeRunValidationMode(input: {
  projectPath: string;
  config: GraphWorkflowLaneMergeValidationConfig;
  readRepoConfig: ReadLaneMergeRepoConfig;
}): Promise<RunMergeValidationMode> {
  if (input.config.commands.mode === "only") {
    return {
      mode: "run",
      source: "graph_lane_merge",
      selection: {
        mode: "only",
        commands: [...input.config.commands.commands],
      },
    };
  }

  const repoConfig = await input.readRepoConfig(input.projectPath);
  const commands =
    repoConfig?.validation?.laneMerge ?? repoConfig?.validation?.preMerge ?? [];
  return {
    mode: "run",
    source: "graph_lane_merge",
    selection: { mode: "only", commands: [...commands] },
  };
}

/**
 * What a lane-merge validation run identifies itself as in the join's evidence
 * ledger: the `+`-joined command list, `""` for a selection that runs nothing.
 *
 * A `project-pre-merge` selection names a repo-config list resolved at
 * submission rather than a list decided here, so it identifies itself by that
 * name. Lane-merge resolution never produces one — it always resolves the
 * project list into an explicit selection first.
 */
export function laneMergeCommandIdentity(mode: RunMergeValidationMode): string {
  const selection = mode.selection;
  return selection.mode === "only"
    ? selection.commands.join("+")
    : "project-pre-merge";
}
