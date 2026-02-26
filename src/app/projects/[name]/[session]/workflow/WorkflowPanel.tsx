"use client";

import { useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import TaskPlanEditor from "./TaskPlanEditor";
import IterationTimeline from "./IterationTimeline";
import WorkflowConfigPanel from "./WorkflowConfigPanel";
import LiveIterationStream from "./LiveIterationStream";
import CumulativeDiff from "./CumulativeDiff";
import type {
  RalphLoopWorkflow,
  RalphLoopConfig,
  WorkflowStatus,
  HaltReason,
  TaskPriority,
  CircuitBreakerStateEnum,
} from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkflowPanelProps {
  projectName: string;
  sessionName: string;
  workflow: RalphLoopWorkflow | null;
  onActivate?: () => void;
  onObjectiveChange?: (objective: string) => void;
  onConfirmStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  onTaskAdd?: (description: string, priority: TaskPriority) => void;
  onTaskRemove?: (taskId: string) => void;
  onTaskEdit?: (taskId: string, description: string) => void;
  onTaskReorder?: (taskIds: string[]) => void;
  onGeneratePlan?: () => void;
  onConfigChange?: (config: RalphLoopConfig) => void;
  onResetCircuitBreaker?: () => void;
  isGenerating?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function getStatusLabel(status: WorkflowStatus): string {
  const labels: Record<WorkflowStatus, string> = {
    planning: "Planning",
    running: "Running",
    paused: "Paused",
    completed: "Completed",
    halted: "Halted",
    aborted: "Aborted",
  };
  return labels[status];
}

function getStatusIcon(status: WorkflowStatus): string {
  const icons: Record<WorkflowStatus, string> = {
    planning: "\u25C7",
    running: "\u25CF",
    paused: "\u2016",
    completed: "\u2713",
    halted: "\u26A0",
    aborted: "\u2715",
  };
  return icons[status];
}

function getCBLabel(state: CircuitBreakerStateEnum): string {
  const labels: Record<CircuitBreakerStateEnum, string> = {
    closed: "Healthy",
    half_open: "Recovery",
    open: "Tripped",
  };
  return labels[state];
}

function getCBDotClass(state: CircuitBreakerStateEnum): string {
  if (state === "half_open") return "half-open";
  return state;
}

function getHaltDisplay(reason: HaltReason): {
  title: string;
  description: string;
  icon: string;
  classification: "success" | "problem" | "neutral";
} {
  switch (reason.type) {
    case "plan_complete":
      return {
        title: "All Tasks Complete",
        description:
          "Every task in the plan has been completed or skipped successfully.",
        icon: "\u2713",
        classification: "success",
      };
    case "iteration_cap":
      return {
        title: "Iteration Limit Reached",
        description: `Reached the maximum of ${reason.maxIterations} iterations.`,
        icon: "\u26A1",
        classification: "problem",
      };
    case "circuit_breaker":
      return {
        title: "Circuit Breaker Tripped",
        description:
          reason.reason === "no_progress"
            ? "No progress detected across consecutive iterations."
            : "Same error repeated across consecutive iterations.",
        icon: "\u26A0",
        classification: "problem",
      };
    case "permission_denied":
      return {
        title: "Permission Denied",
        description: "Claude was denied tool access in consecutive iterations.",
        icon: "\uD83D\uDD12",
        classification: "problem",
      };
    case "test_saturation":
      return {
        title: "Test Saturation",
        description:
          "Too many consecutive test-only iterations without implementation work.",
        icon: "\u27F3",
        classification: "problem",
      };
    case "stalled_exit_signal":
      return {
        title: "Stalled \u2014 Tasks Remaining",
        description: `Claude believes work is done, but ${reason.remainingTasks} task(s) remain unresolved. Review whether remaining tasks should be completed, skipped, or removed.`,
        icon: "\u26A0",
        classification: "problem",
      };
    case "aborted":
      return {
        title: "Workflow Aborted",
        description: "The workflow was manually aborted by the user.",
        icon: "\u2715",
        classification: "neutral",
      };
    case "context_limit":
      return {
        title: "Context Limit Reached",
        description:
          "The iteration was ended because it exceeded the context token limit.",
        icon: "\u26A1",
        classification: "neutral",
      };
  }
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function WorkflowPanel({
  projectName,
  sessionName,
  workflow,
  onActivate,
  onObjectiveChange,
  onConfirmStart,
  onPause,
  onResume,
  onAbort,
  onTaskAdd,
  onTaskRemove,
  onTaskEdit,
  onTaskReorder,
  onGeneratePlan,
  onConfigChange,
  onResetCircuitBreaker,
  isGenerating = false,
}: WorkflowPanelProps) {
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [configExpanded, setConfigExpanded] = useState(false);

  // --- Activation CTA (no workflow) ---
  if (!workflow) {
    return (
      <div className="workflow-panel">
        <div className="workflow-activate">
          <div className="workflow-activate-icon">{"\u27F3"}</div>
          <div className="workflow-activate-title">Ralph Loop</div>
          <p className="workflow-activate-description">
            Run Claude Code in an autonomous loop until your objective is
            complete. Define tasks, set limits, and monitor progress in
            real-time.
          </p>
          <button className="btn btn-primary" onClick={onActivate}>
            Start Workflow
          </button>
        </div>
      </div>
    );
  }

  const { status } = workflow;

  return (
    <div className="workflow-panel">
      {/* Header */}
      <div className="workflow-panel-header">
        <div className={`workflow-panel-icon ${status}`}>
          {getStatusIcon(status)}
        </div>
        <span className="workflow-panel-title">Ralph Loop</span>
        <span className={`workflow-status-badge ${status}`}>
          {getStatusLabel(status)}
        </span>
      </div>

      {/* Body */}
      <div className="workflow-panel-body">
        {status === "planning" && (
          <PlanningView
            workflow={workflow}
            onObjectiveChange={onObjectiveChange}
            onTaskAdd={onTaskAdd}
            onTaskRemove={onTaskRemove}
            onTaskEdit={onTaskEdit}
            onTaskReorder={onTaskReorder}
            onGeneratePlan={onGeneratePlan}
            onConfigChange={onConfigChange}
            onConfirmStart={onConfirmStart}
            isGenerating={isGenerating}
            configExpanded={configExpanded}
            onToggleConfig={() => setConfigExpanded(!configExpanded)}
          />
        )}

        {(status === "running" || status === "paused") && (
          <MonitoringView
            projectName={projectName}
            sessionName={sessionName}
            workflow={workflow}
            onConfigChange={onConfigChange}
            onTaskEdit={onTaskEdit}
            onTaskReorder={onTaskReorder}
            onTaskRemove={onTaskRemove}
            onTaskAdd={onTaskAdd}
          />
        )}

        {(status === "completed" ||
          status === "halted" ||
          status === "aborted") && (
          <CompletionView
            workflow={workflow}
            onResetCircuitBreaker={onResetCircuitBreaker}
            onResume={onResume}
          />
        )}
      </div>

      {/* Footer — control bar for active states */}
      {(status === "running" || status === "paused" || status === "halted") && (
        <div className="workflow-panel-footer">
          <ControlBar
            status={status}
            circuitBreakerState={workflow.circuitBreaker.state}
            onPause={onPause}
            onResume={onResume}
            onAbort={() => setShowAbortConfirm(true)}
            onResetCircuitBreaker={onResetCircuitBreaker}
          />
        </div>
      )}

      {/* Abort confirmation */}
      <ConfirmDialog
        open={showAbortConfirm}
        title="Abort Workflow"
        message="This will terminate the current iteration and stop the workflow. All completed work is preserved."
        confirmLabel="Abort"
        danger
        onConfirm={() => {
          setShowAbortConfirm(false);
          onAbort?.();
        }}
        onCancel={() => setShowAbortConfirm(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planning View
// ---------------------------------------------------------------------------

function PlanningView({
  workflow,
  onObjectiveChange,
  onTaskAdd,
  onTaskRemove,
  onTaskEdit,
  onTaskReorder,
  onGeneratePlan,
  onConfigChange,
  onConfirmStart,
  isGenerating,
  configExpanded,
  onToggleConfig,
}: {
  workflow: RalphLoopWorkflow;
  onObjectiveChange?: (v: string) => void;
  onTaskAdd?: (desc: string, priority: TaskPriority) => void;
  onTaskRemove?: (id: string) => void;
  onTaskEdit?: (id: string, description: string) => void;
  onTaskReorder?: (taskIds: string[]) => void;
  onGeneratePlan?: () => void;
  onConfigChange?: (config: RalphLoopConfig) => void;
  onConfirmStart?: () => void;
  isGenerating: boolean;
  configExpanded: boolean;
  onToggleConfig: () => void;
}) {
  const canStart =
    workflow.objective.trim().length > 0 && workflow.fixPlan.length > 0;

  return (
    <>
      {/* Objective */}
      <div className="wf-section">
        <label className="wf-section-label" htmlFor="wf-objective">
          Objective
        </label>
        <textarea
          id="wf-objective"
          className="workflow-objective-textarea"
          placeholder="Describe what Claude should accomplish&#8230;"
          value={workflow.objective}
          onChange={(e) => onObjectiveChange?.(e.target.value)}
        />
      </div>

      {/* Task Plan */}
      <TaskPlanEditor
        tasks={workflow.fixPlan}
        showProgress
        showGenerateButton
        isGenerating={isGenerating}
        onTaskAdd={onTaskAdd}
        onTaskRemove={onTaskRemove}
        onTaskEdit={onTaskEdit}
        onTaskReorder={onTaskReorder}
        onGeneratePlan={onGeneratePlan}
      />

      {/* Configuration */}
      <div className="workflow-config">
        <button className="workflow-config-toggle" onClick={onToggleConfig}>
          <span
            className={`workflow-config-toggle-arrow${configExpanded ? " expanded" : ""}`}
          >
            {"\u25B8"}
          </span>
          Configuration
        </button>
        {configExpanded && (
          <WorkflowConfigPanel
            config={workflow.config}
            onConfigChange={onConfigChange}
          />
        )}
      </div>

      {/* Confirm & Start */}
      <button
        className="btn btn-primary"
        style={{ alignSelf: "flex-end" }}
        disabled={!canStart}
        onClick={onConfirmStart}
      >
        Confirm &amp; Start {"\u25B6"}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Monitoring View
// ---------------------------------------------------------------------------

function MonitoringView({
  projectName,
  sessionName,
  workflow,
  onConfigChange,
  onTaskEdit,
  onTaskReorder,
  onTaskRemove,
  onTaskAdd,
}: {
  projectName: string;
  sessionName: string;
  workflow: RalphLoopWorkflow;
  onConfigChange?: (config: RalphLoopConfig) => void;
  onTaskEdit?: (id: string, description: string) => void;
  onTaskReorder?: (taskIds: string[]) => void;
  onTaskRemove?: (id: string) => void;
  onTaskAdd?: (desc: string, priority: TaskPriority) => void;
}) {
  const { config, circuitBreaker, iterations, fixPlan, status } = workflow;
  const isPaused = status === "paused";
  const currentIteration = iterations.length;

  const completedTasks = fixPlan.filter((t) => t.status === "completed").length;
  const skippedTasks = fixPlan.filter((t) => t.status === "skipped").length;
  const resolvedTasks = completedTasks + skippedTasks;
  const totalTasks = fixPlan.length;
  const taskPct =
    totalTasks > 0 ? Math.round((resolvedTasks / totalTasks) * 100) : 0;

  return (
    <>
      {/* Metrics strip */}
      <div className="workflow-metrics">
        <div className="workflow-metric">
          <span className="workflow-metric-label">Iteration</span>
          <span className="workflow-iteration-counter">
            <span className="current">
              {String(currentIteration).padStart(2, "0")}
            </span>
            <span className="separator">/</span>
            <span className="max">{config.maxIterations}</span>
          </span>
        </div>
        <div className="workflow-metric">
          <span className="workflow-metric-label">Tasks</span>
          <div className="workflow-task-progress">
            <div className="task-plan-progress-bar" style={{ width: 80 }}>
              <div
                className="task-plan-progress-fill"
                style={{ width: `${taskPct}%` }}
              />
            </div>
            <span className="workflow-metric-value">
              {resolvedTasks}/{totalTasks}
            </span>
          </div>
        </div>
        <div className="workflow-metric">
          <span className="workflow-metric-label">Circuit Breaker</span>
          <div className="circuit-breaker">
            <div
              className={`circuit-breaker-dot ${getCBDotClass(circuitBreaker.state)}`}
            />
            <span
              className={`circuit-breaker-label ${getCBDotClass(circuitBreaker.state)}`}
            >
              {getCBLabel(circuitBreaker.state)}
            </span>
          </div>
        </div>
        <div className="workflow-metric">
          <span className="workflow-metric-label">Elapsed</span>
          <span className="workflow-metric-value">
            {formatDuration(workflow.totalDurationMs)}
          </span>
        </div>
        <div className="workflow-metric">
          <span className="workflow-metric-label">Cost</span>
          <span className="workflow-metric-value">
            {formatCost(workflow.totalCostUsd)}
          </span>
        </div>
      </div>

      {/* Live iteration stream */}
      {status === "running" && (
        <LiveIterationStream
          projectName={projectName}
          sessionName={sessionName}
          iterationNumber={currentIteration + 1}
          isRunning
        />
      )}

      {isPaused && (
        <div className="workflow-between-iterations">
          Workflow paused after iteration {currentIteration}. Edit tasks or
          config, then resume.
        </div>
      )}

      {/* Task Plan (editable when paused, read-only during running) */}
      <TaskPlanEditor
        tasks={fixPlan}
        readOnly={!isPaused}
        showProgress
        onTaskEdit={isPaused ? onTaskEdit : undefined}
        onTaskReorder={isPaused ? onTaskReorder : undefined}
        onTaskRemove={isPaused ? onTaskRemove : undefined}
        onTaskAdd={isPaused ? onTaskAdd : undefined}
      />

      {/* Config (editable when paused) */}
      {isPaused && (
        <div className="workflow-config">
          <span className="wf-section-label">Configuration</span>
          <WorkflowConfigPanel
            config={config}
            onConfigChange={onConfigChange}
          />
        </div>
      )}

      {/* Iteration History */}
      <IterationTimeline iterations={iterations} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Completion View
// ---------------------------------------------------------------------------

function CompletionView({
  workflow,
  onResetCircuitBreaker,
  onResume,
}: {
  workflow: RalphLoopWorkflow;
  onResetCircuitBreaker?: () => void;
  onResume?: () => void;
}) {
  const halt = workflow.haltReason
    ? getHaltDisplay(workflow.haltReason)
    : {
        title: "Unknown",
        description: "",
        icon: "?",
        classification: "neutral" as const,
      };

  const bannerClass =
    halt.classification === "success"
      ? "success"
      : halt.classification === "problem"
        ? "problem"
        : "neutral";

  const completedTasks = workflow.fixPlan.filter(
    (t) => t.status === "completed",
  ).length;
  const pendingTasks = workflow.fixPlan.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;

  return (
    <>
      {/* Outcome banner */}
      <div className={`workflow-completion-banner ${bannerClass}`}>
        <span className="workflow-completion-icon">{halt.icon}</span>
        <div className="workflow-completion-text">
          <span className="workflow-completion-title">{halt.title}</span>
          <span className="workflow-completion-reason">{halt.description}</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="workflow-stats-grid">
        <div className="workflow-stat">
          <span className="workflow-stat-label">Iterations</span>
          <span className="workflow-stat-value">
            {workflow.iterations.length}
          </span>
        </div>
        <div className="workflow-stat">
          <span className="workflow-stat-label">Duration</span>
          <span className="workflow-stat-value">
            {formatDuration(workflow.totalDurationMs)}
          </span>
        </div>
        <div className="workflow-stat">
          <span className="workflow-stat-label">Cost</span>
          <span className="workflow-stat-value">
            {formatCost(workflow.totalCostUsd)}
          </span>
        </div>
        <div className="workflow-stat">
          <span className="workflow-stat-label">Tasks</span>
          <span className="workflow-stat-value">
            {completedTasks}
            <span style={{ color: "var(--text-tertiary)", fontWeight: 400 }}>
              /{workflow.fixPlan.length}
            </span>
          </span>
        </div>
      </div>

      {/* Cumulative git diff */}
      <CumulativeDiff iterations={workflow.iterations} />

      {/* Recovery actions for problematic halts */}
      {halt.classification === "problem" && (
        <div className="workflow-recovery">
          <span className="workflow-recovery-title">Recovery Options</span>
          <span className="workflow-recovery-description">
            {workflow.haltReason?.type === "circuit_breaker"
              ? "Reset the circuit breaker and resume to retry, or edit the task plan to simplify remaining work."
              : workflow.haltReason?.type === "stalled_exit_signal"
                ? "Review remaining tasks below. Skip or remove tasks that are no longer needed, then resume."
                : "Review the task plan and adjust as needed, then resume the workflow."}
          </span>
          <div className="workflow-recovery-actions">
            {workflow.haltReason?.type === "circuit_breaker" && (
              <button className="btn btn-sm" onClick={onResetCircuitBreaker}>
                Reset Circuit Breaker
              </button>
            )}
            <button className="btn btn-sm btn-primary" onClick={onResume}>
              Resume Workflow
            </button>
          </div>
        </div>
      )}

      {/* Stalled exit signal — highlight remaining tasks */}
      {workflow.haltReason?.type === "stalled_exit_signal" &&
        pendingTasks > 0 && (
          <div className="workflow-lock-banner">
            <span className="workflow-lock-banner-icon">{"\u26A0"}</span>
            {pendingTasks} task(s) remain unresolved. Review and skip, remove,
            or resume to continue.
          </div>
        )}

      {/* Task Plan (final state) */}
      <TaskPlanEditor tasks={workflow.fixPlan} readOnly showProgress />

      {/* Iteration History */}
      <IterationTimeline iterations={workflow.iterations} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Control Bar
// ---------------------------------------------------------------------------

function ControlBar({
  status,
  circuitBreakerState,
  onPause,
  onResume,
  onAbort,
  onResetCircuitBreaker,
}: {
  status: WorkflowStatus;
  circuitBreakerState: CircuitBreakerStateEnum;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  onResetCircuitBreaker?: () => void;
}) {
  return (
    <div className="workflow-controls">
      {status === "running" && (
        <button className="btn btn-sm btn-amber" onClick={onPause}>
          {"\u23F8"} Pause
        </button>
      )}
      {(status === "paused" || status === "halted") && (
        <>
          {circuitBreakerState === "open" && (
            <button className="btn btn-sm" onClick={onResetCircuitBreaker}>
              Reset CB
            </button>
          )}
          <button className="btn btn-sm btn-primary" onClick={onResume}>
            {"\u25B6"} Resume
          </button>
        </>
      )}
      {(status === "running" || status === "paused") && (
        <button className="btn btn-sm btn-danger" onClick={onAbort}>
          {"\u2715"} Abort
        </button>
      )}
    </div>
  );
}
