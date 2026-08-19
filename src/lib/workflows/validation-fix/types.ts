import type { ValidationRunSource } from "@/lib/validation/schemas";
import type { ValidationSystemSubmitRequest } from "@/lib/validation/service";
import type { GraphWorkflowLaneMergeCommandSelector } from "@/lib/workflow-graph/config-schemas";

export type MergeValidationSource = Extract<
  ValidationRunSource,
  "graph_lane_merge" | "smart_merge" | "smart_commit"
>;

export type ValidationCommandSelection =
  | { mode: "project-pre-merge" }
  | Extract<GraphWorkflowLaneMergeCommandSelector, { mode: "only" }>;

export type ValidationWorkflowRef = NonNullable<
  ValidationSystemSubmitRequest["workflow"]
>;

export interface RunMergeValidationMode {
  mode: "run";
  source: MergeValidationSource;
  selection: ValidationCommandSelection;
  coveredLaneIds?: string[];
  coveredContextIds?: string[];
}

export type MergeValidationMode = { mode: "skip" } | RunMergeValidationMode;
