/**
 * Re-export workflow types from the canonical schema-derived types.
 * UI components import from here for convenience.
 */
export type {
  WorkflowStatus,
  FixPlanTask,
  FixPlanTaskStatus as TaskStatus,
  CircuitBreakerState,
  CircuitBreakerStateEnum,
  CircuitBreakerConfig,
  RalphLoopConfig,
  GitIterationMetrics,
  ReportStatusInput as StatusReport,
  HaltReason,
  RalphLoopIterationMeta as IterationMeta,
  RalphLoopWorkflow,
} from "@/types";

// Convenience re-exports for common sub-types
export type TaskPriority = "high" | "medium" | "low";
export type WorkType =
  | "implementation"
  | "testing"
  | "documentation"
  | "refactoring";
