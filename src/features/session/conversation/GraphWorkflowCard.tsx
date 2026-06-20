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
import { Button } from "@/components/ui/Button";

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
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-inherit no-underline [transition:border-color_0.15s_ease,background_0.15s_ease] hover:border-border-strong hover:bg-bg-elevated"
    >
      <div className="flex items-center gap-sm">
        <span
          className="inline-flex items-center gap-[4px] font-mono text-[0.7rem] tracking-[0.04em] uppercase"
          style={{ color: statusColor }}
        >
          <span className="text-[0.75rem]">{getStatusIcon(status)}</span>
          {getStatusLabel(status)}
        </span>
        {activeContext && status === "running" && (
          <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
            {activeContext.title}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-[2px]">
        <div className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
          Graph Workflow
        </div>
        <div className="text-[0.85rem] leading-[1.4] text-text-secondary">
          {execution.workingDefinition.executionContexts
            .map((c) => c.title)
            .join(" \u2192 ")}
        </div>
      </div>
      {progress.total > 0 && (
        <div className="mt-xs flex items-center gap-sm">
          <div className="h-[4px] flex-1 overflow-hidden rounded-[2px] bg-[var(--bg-inset)]">
            <div
              className="h-full rounded-[2px] bg-cyan [transition:width_0.3s_ease]"
              style={{
                width: `${Math.round((progress.completed / progress.total) * 100)}%`,
              }}
            />
          </div>
          <span className="font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
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
      <div className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md">
        <div className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
          Graph Workflow
        </div>
        <div className="font-mono text-[0.78rem] text-text-tertiary">
          Loading definitions...
        </div>
      </div>
    );
  }

  if (definitions.length === 0) {
    return (
      <div className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md">
        <div className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
          Graph Workflow
        </div>
        <div className="font-mono text-[0.78rem] text-text-tertiary">
          No workflow definitions found for this project.
        </div>
        <Link
          href={`/projects/${encodeURIComponent(projectName)}/workflows`}
          className="font-mono text-[0.72rem] text-text-tertiary! no-underline [transition:color_0.15s] hover:text-cyan!"
        >
          Build a workflow definition \u2192
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md">
      <div className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
        Graph Workflow
      </div>
      <select
        className="w-full cursor-pointer rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[8px] font-mono text-[0.78rem] text-text-primary outline-none [transition:border-color_0.15s] focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]"
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
      <div className="flex items-center justify-between gap-sm">
        {selected && (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            rev {selected.revision}
          </span>
        )}
        <div className="ml-auto flex items-center gap-sm">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/workflows`}
            className="font-mono text-[0.72rem] text-text-tertiary! no-underline [transition:color_0.15s] hover:text-cyan!"
          >
            Edit definitions
          </Link>
          <Button
            variant="primary"
            size="sm"
            touch
            disabled={!selectedId || starting}
            onClick={() => selectedId && onRun?.(selectedId)}
            type="button"
          >
            {starting ? "Starting..." : "Run Workflow"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-xs font-mono text-[0.72rem] text-red">{error}</div>
      )}
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
