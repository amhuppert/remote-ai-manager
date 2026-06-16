"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  GraphWorkflowExecution,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import { useWorkflowDefinitionsQuery } from "@/lib/workflows/queries";
import { useStartGraphWorkflowMutation } from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import ConfirmDialog from "@/components/ConfirmDialog";

interface GraphWorkflowCardProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  isFinished: boolean;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function getStatusColor(status: GraphWorkflowStatus): string {
  switch (status) {
    case "pending":
      return "var(--text-secondary)";
    case "running":
      return "var(--cyan)";
    case "paused":
      return "var(--amber)";
    case "completed":
      return "var(--green)";
    case "halted":
    case "aborted":
      return "var(--red)";
  }
}

function getStatusIcon(status: GraphWorkflowStatus): string {
  switch (status) {
    case "pending":
      return "\u25C7"; // diamond
    case "running":
      return "\u25CF"; // filled circle
    case "paused":
      return "\u25A0"; // filled square
    case "completed":
      return "\u2713"; // checkmark
    case "halted":
    case "aborted":
      return "\u26A0"; // warning
  }
}

function getStatusLabel(status: GraphWorkflowStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function computeProgress(execution: GraphWorkflowExecution): {
  completed: number;
  total: number;
} {
  const states = Object.values(execution.taskStates);
  return {
    completed: states.filter((s) => s.status === "completed").length,
    total: states.length,
  };
}

// ---------------------------------------------------------------------------
// Active execution card — links to the execution viewer
// ---------------------------------------------------------------------------

export function ExecutionStatusCard({
  projectName,
  sessionName,
  execution,
}: {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}): React.JSX.Element {
  const status = execution.status;
  const statusColor = getStatusColor(status);
  const progress = computeProgress(execution);
  const activeContextId = execution.activeContextIds[0];
  const activeContext = activeContextId
    ? execution.workingDefinition.executionContexts.find(
        (c) => c.id === activeContextId,
      )
    : null;

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
        {activeContext && status === "running" && (
          <span className="workflow-card-iteration">{activeContext.title}</span>
        )}
      </div>
      <div className="workflow-card-body">
        <div className="workflow-card-label">Graph Workflow</div>
        <div className="workflow-card-objective">
          {execution.workingDefinition.executionContexts
            .map((c) => c.title)
            .join(" \u2192 ")}
        </div>
      </div>
      {progress.total > 0 && (
        <div className="workflow-card-footer">
          <div className="workflow-card-progress-bar">
            <div
              className="workflow-card-progress-fill"
              style={{
                width: `${Math.round((progress.completed / progress.total) * 100)}%`,
              }}
            />
          </div>
          <span className="workflow-card-progress-text">
            {progress.completed}/{progress.total} tasks completed
          </span>
        </div>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Launcher card — presentational core (exported for Storybook)
// ---------------------------------------------------------------------------

export interface DefinitionSummary {
  id: string;
  name: string;
  revision: number;
}

export function GraphWorkflowLauncher({
  projectName,
  definitions,
  loading = false,
  starting = false,
  error,
  onRun,
}: {
  projectName: string;
  definitions: DefinitionSummary[];
  loading?: boolean;
  starting?: boolean;
  error?: string | null;
  onRun?: (definitionId: string) => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = definitions.find((d) => d.id === selectedId);

  if (loading) {
    return (
      <div className="gw-launcher">
        <div className="gw-launcher-label">Graph Workflow</div>
        <div className="gw-launcher-empty">Loading definitions...</div>
      </div>
    );
  }

  if (definitions.length === 0) {
    return (
      <div className="gw-launcher">
        <div className="gw-launcher-label">Graph Workflow</div>
        <div className="gw-launcher-empty">
          No workflow definitions found for this project.
        </div>
        <Link
          href={`/projects/${encodeURIComponent(projectName)}/workflows`}
          className="gw-launcher-link"
        >
          Build a workflow definition \u2192
        </Link>
      </div>
    );
  }

  return (
    <div className="gw-launcher">
      <div className="gw-launcher-label">Graph Workflow</div>
      <select
        className="gw-launcher-select"
        value={selectedId ?? ""}
        onChange={(e) => setSelectedId(e.target.value || null)}
      >
        <option value="">Select a definition{"\u2026"}</option>
        {definitions.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <div className="gw-launcher-footer">
        {selected && (
          <span className="gw-launcher-meta">rev {selected.revision}</span>
        )}
        <div className="gw-launcher-actions">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/workflows`}
            className="gw-launcher-link"
          >
            Edit definitions
          </Link>
          <button
            className="btn btn-primary btn-sm"
            disabled={!selectedId || starting}
            onClick={() => selectedId && onRun?.(selectedId)}
            type="button"
          >
            {starting ? "Starting..." : "Run Workflow"}
          </button>
        </div>
      </div>
      {error && <div className="gw-launcher-error">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected launcher — wires query + mutation
// ---------------------------------------------------------------------------

function ConnectedLauncherCard({
  projectName,
  sessionName,
}: {
  projectName: string;
  sessionName: string;
}): React.JSX.Element {
  const definitionsQuery = useWorkflowDefinitionsQuery(projectName);
  const startMutation = useStartGraphWorkflowMutation(projectName, sessionName);
  const [uncommittedMessage, setUncommittedMessage] = useState<string | null>(
    null,
  );

  const startError = startMutation.error;
  const isUncommittedBlock =
    startError instanceof ApiCallError &&
    startError.code === "uncommitted_changes";

  return (
    <>
      <GraphWorkflowLauncher
        projectName={projectName}
        definitions={(definitionsQuery.data ?? []).map((d) => ({
          id: d.id,
          name: d.name,
          revision: d.revision,
        }))}
        loading={definitionsQuery.isPending}
        starting={startMutation.isPending}
        error={
          startMutation.isError && !isUncommittedBlock
            ? startError instanceof Error
              ? startError.message
              : "Failed to start workflow"
            : null
        }
        onRun={(definitionId) =>
          startMutation.mutate(definitionId, {
            onError: (error) => {
              if (
                error instanceof ApiCallError &&
                error.code === "uncommitted_changes"
              ) {
                setUncommittedMessage(error.message);
              }
            },
          })
        }
      />
      <ConfirmDialog
        open={uncommittedMessage !== null}
        title="Commit changes before starting"
        message={uncommittedMessage ?? ""}
        confirmLabel="Got it"
        hideCancel
        onConfirm={() => setUncommittedMessage(null)}
        onCancel={() => setUncommittedMessage(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component — switches between launcher and status card
// ---------------------------------------------------------------------------

export default function GraphWorkflowCard({
  projectName,
  sessionName,
  execution,
  isFinished,
}: GraphWorkflowCardProps): React.JSX.Element {
  if (execution) {
    return (
      <ExecutionStatusCard
        projectName={projectName}
        sessionName={sessionName}
        execution={execution}
      />
    );
  }

  if (isFinished) {
    return <></>;
  }

  return (
    <ConnectedLauncherCard
      projectName={projectName}
      sessionName={sessionName}
    />
  );
}
