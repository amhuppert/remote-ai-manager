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
