import type { ExecutionRequirements } from "@/lib/agent-backends/execution-admission";

export const namingExecutionRequirements = {
  facet: "tasks",
  executionClass: "nongoverned-task",
  executionProfile: "isolated-one-shot",
  operation: "conversation-naming",
} as const satisfies ExecutionRequirements;
export const compactionExecutionRequirements = {
  facet: "tasks",
  executionClass: "nongoverned-task",
  executionProfile: "standard",
  operation: "compaction",
} as const satisfies ExecutionRequirements;
export const compactionRepairRequirements = {
  ...compactionExecutionRequirements,
  executionProfile: "isolated-one-shot",
  operation: "compaction-repair",
} as const satisfies ExecutionRequirements;
