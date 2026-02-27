"use client";

import Link from "next/link";
import type { RalphLoopWorkflow, WorkflowStatus } from "@/types";
import { useWorkflowBySession } from "@/stores/workflow.store";

interface WorkflowCardProps {
  projectName: string;
  sessionName: string;
  workflow: RalphLoopWorkflow;
}

function getStatusColor(status: WorkflowStatus): string {
  switch (status) {
    case "planning":
      return "var(--text-secondary)";
    case "running":
      return "var(--cyan)";
    case "paused":
      return "var(--amber)";
    case "completed":
      return "var(--green)";
    case "halted":
      return "var(--red)";
    case "aborted":
      return "var(--text-tertiary)";
  }
}

function getStatusIcon(status: WorkflowStatus): string {
  switch (status) {
    case "planning":
      return "\u25C7"; // diamond
    case "running":
      return "\u25CF"; // circle
    case "paused":
      return "\u2016"; // double vertical
    case "completed":
      return "\u2713"; // checkmark
    case "halted":
      return "\u2717"; // X
    case "aborted":
      return "\u2014"; // em dash
  }
}

function getStatusLabel(status: WorkflowStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function WorkflowCard({
  projectName,
  sessionName,
  workflow,
}: WorkflowCardProps): React.JSX.Element {
  // Merge SSE-driven store data for real-time updates
  const sseData = useWorkflowBySession(projectName, sessionName);

  const status = sseData?.status ?? workflow.status;
  const taskProgress = sseData?.taskProgress ?? {
    total: workflow.fixPlan.length,
    completed: workflow.fixPlan.filter((t) => t.status === "completed").length,
    skipped: workflow.fixPlan.filter((t) => t.status === "skipped").length,
    pending: workflow.fixPlan.filter((t) => t.status === "pending").length,
  };
  const iterationCount = sseData?.iterationCount ?? workflow.iterations.length;

  const objective =
    workflow.objective.length > 120
      ? workflow.objective.slice(0, 117) + "..."
      : workflow.objective;

  const statusColor = getStatusColor(status);

  return (
    <Link
      href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/workflow`}
      className="workflow-card"
    >
      <div className="workflow-card-header">
        <span className="workflow-card-badge" style={{ color: statusColor }}>
          <span className="workflow-card-badge-icon">
            {getStatusIcon(status)}
          </span>
          {getStatusLabel(status)}
        </span>
        {status === "running" && iterationCount > 0 && (
          <span className="workflow-card-iteration">
            Iteration {iterationCount}
          </span>
        )}
      </div>
      <div className="workflow-card-body">
        <div className="workflow-card-label">Ralph Loop</div>
        <div className="workflow-card-objective">
          {objective || "No objective set"}
        </div>
      </div>
      {taskProgress.total > 0 && (
        <div className="workflow-card-footer">
          <div className="workflow-card-progress-bar">
            <div
              className="workflow-card-progress-fill"
              style={{
                width: `${Math.round(((taskProgress.completed + taskProgress.skipped) / taskProgress.total) * 100)}%`,
              }}
            />
          </div>
          <span className="workflow-card-progress-text">
            {taskProgress.completed}/{taskProgress.total} tasks completed
          </span>
        </div>
      )}
    </Link>
  );
}
