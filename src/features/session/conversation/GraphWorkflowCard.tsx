"use client";

import { useState } from "react";
import Link from "next/link";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type {
  TemplateLibraryItem,
  TemplateTier,
} from "@/lib/workflow-graph/template-library-service";
import { useProjectTemplatesQuery } from "@/lib/workflows/queries";
import {
  useStartGraphWorkflowMutation,
  type StartGraphWorkflowResult,
} from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/Select";
import WorkflowLaunchForm from "@/components/WorkflowLaunchForm";

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
  tier: TemplateTier;
}

interface DefinitionIdentity {
  id: string;
  tier: TemplateTier;
}

function definitionSelectionKey(definition: DefinitionIdentity): string {
  return JSON.stringify([definition.tier, definition.id]);
}

const tierBadgeLabel: Record<TemplateTier, string> = {
  global: "Global",
  project: "Project",
};

// The launcher lists both tiers, so each option carries a tier badge \u2014 global
// templates use the cyan "feature" badge, project the amber "idea" badge, the
// same mapping the full template library uses so the two surfaces read alike.
function tierBadge(tier: TemplateTier): React.JSX.Element {
  return (
    <Badge
      tier="type"
      kind={tier === "global" ? "feature" : "idea"}
      layoutClassName="shrink-0"
    >
      {tierBadgeLabel[tier]}
    </Badge>
  );
}

// Secondary actions read as buttons (bordered chip, not dim text): they rest at
// text-secondary \u2014 never text-tertiary for interactive text \u2014 and promote to
// text-primary on hover. The Button primitive has no anchor form yet, so this
// mirrors its bordered recipe on a Link that must navigate.
const secondaryActionClass =
  "inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-transparent px-sm py-[6px] font-mono text-[0.72rem] text-text-secondary no-underline transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary!";

// Rotates via the Radix Select trigger's `data-state=open` on the enclosing
// `group` button (the trigger is a `SelectTrigger asChild`).
function ChevronDown(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-[14px] shrink-0 text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function LauncherShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md">
      <span className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
        Graph Workflow
      </span>
      {children}
    </div>
  );
}

export function GraphWorkflowLauncher({
  projectName,
  sessionName,
  definitions,
  loading = false,
  starting = false,
  error,
  onRun,
  onSelectionChange,
  awaitingApproval,
}: {
  projectName: string;
  sessionName: string;
  definitions: DefinitionSummary[];
  loading?: boolean;
  starting?: boolean;
  error?: string | null;
  onRun?: (definition: DefinitionIdentity) => void;
  awaitingApproval?: Extract<
    StartGraphWorkflowResult,
    { kind: "awaiting_approval" }
  > | null;
  /** Reports the currently selected cross-tier identity (null when cleared). */
  onSelectionChange?: (definition: DefinitionIdentity | null) => void;
}): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const templatesHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/templates`;
  const workflowsHref = `/projects/${encodeURIComponent(projectName)}/workflows`;
  const selected =
    definitions.find(
      (definition) => definitionSelectionKey(definition) === selectedKey,
    ) ?? null;

  function selectDefinition(selectionKey: string): void {
    const definition =
      definitions.find(
        (candidate) => definitionSelectionKey(candidate) === selectionKey,
      ) ?? null;
    setSelectedKey(definition === null ? null : selectionKey);
    onSelectionChange?.(
      definition === null ? null : { id: definition.id, tier: definition.tier },
    );
  }

  if (loading) {
    return (
      <LauncherShell>
        <div className="font-mono text-[0.78rem] text-text-tertiary">
          Loading templates{"\u2026"}
        </div>
      </LauncherShell>
    );
  }

  if (definitions.length === 0) {
    return (
      <LauncherShell>
        <div className="font-mono text-[0.78rem] text-text-tertiary">
          No workflow templates available for this project or the global
          library.
        </div>
        <Link href={workflowsHref} className={secondaryActionClass}>
          Build a workflow definition {"\u2192"}
        </Link>
      </LauncherShell>
    );
  }

  return (
    <LauncherShell>
      {/* Collapsed dropdown over the Radix-backed `Select` primitive (single-value
          listbox value-picker). Radix owns the listbox roving focus + arrow/Home/
          End/type-ahead keyboard nav, collision-aware portalled positioning,
          outside-click/Escape dismissal, and `useOverlayScope` registration \u2014
          replacing the hand-rolled portal/position/outside-click machinery. The
          trigger keeps its rich selected display (tier badge + name + revision)
          via `SelectTrigger asChild`. */}
      <Select value={selectedKey ?? ""} onValueChange={selectDefinition}>
        <SelectTrigger asChild aria-label="Select a workflow">
          <button
            type="button"
            className="group flex w-full items-center gap-sm rounded-md border border-solid border-border-default bg-bg-base px-sm py-[8px] text-left font-mono text-[0.8rem] transition-[border-color,box-shadow] duration-150 ease-[ease] outline-none hover:border-border-strong focus-visible:border-cyan focus-visible:shadow-[0_0_0_1px_var(--color-cyan-glow)]"
          >
            {selected ? (
              <>
                {tierBadge(selected.tier)}
                <span className="min-w-0 flex-1 truncate text-text-primary">
                  {selected.name}
                </span>
                <span className="shrink-0 text-[0.7rem] text-text-tertiary">
                  rev {selected.revision}
                </span>
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate text-text-tertiary">
                Select a workflow{"\u2026"}
              </span>
            )}
            <ChevronDown />
          </button>
        </SelectTrigger>
        <SelectContent>
          {definitions.map((d) => (
            <SelectItem
              key={`${d.tier}:${d.id}`}
              value={definitionSelectionKey(d)}
              description={`rev ${d.revision}`}
            >
              {tierBadge(d.tier)}
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex flex-wrap items-center gap-sm">
        <Link href={workflowsHref} className={secondaryActionClass}>
          Edit definitions
        </Link>
        <Link href={templatesHref} className={secondaryActionClass}>
          Template library {"\u2192"}
        </Link>
        <Button
          variant="primary"
          size="sm"
          touch
          layoutClassName="ml-auto"
          disabled={selected === null || starting}
          onClick={() =>
            selected && onRun?.({ id: selected.id, tier: selected.tier })
          }
          type="button"
        >
          {starting ? "Starting\u2026" : "Run Workflow"}
        </Button>
      </div>
      {error && (
        <div className="mt-xs font-mono text-[0.72rem] text-red">{error}</div>
      )}
      {awaitingApproval && (
        <div
          role="status"
          className="flex flex-col gap-xs rounded-md border border-solid border-amber-dim bg-amber-glow p-sm"
        >
          <span className="font-mono text-[0.72rem] font-semibold text-amber">
            Definition awaiting approval
          </span>
          <span className="font-mono text-[0.7rem] text-text-secondary">
            {awaitingApproval.instruction}
          </span>
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/workflow`}
            className="font-mono text-[0.7rem] font-semibold text-amber underline"
          >
            Open workflow monitor
          </Link>
        </div>
      )}
    </LauncherShell>
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
  // Cross-tier list (global + project), each item already carrying its
  // parameters/prerequisites — no per-definition follow-up fetch needed.
  const templatesQuery = useProjectTemplatesQuery(projectName);
  const startMutation = useStartGraphWorkflowMutation(projectName, sessionName);
  const [uncommittedMessage, setUncommittedMessage] = useState<string | null>(
    null,
  );
  // The template whose launch form is open. Held as the full item so the modal
  // keeps the launched template's tier + parameters even if the selection
  // changes underneath it.
  const [launchItem, setLaunchItem] = useState<TemplateLibraryItem | null>(
    null,
  );
  // Engine-side launch rejection surfaced inside the form (the start route's 400
  // input-validation error names the offending parameter).
  const [engineError, setEngineError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState<Extract<
    StartGraphWorkflowResult,
    { kind: "awaiting_approval" }
  > | null>(null);

  const items = templatesQuery.data ?? [];

  const startError = startMutation.error;
  const isUncommittedBlock =
    startError instanceof ApiCallError &&
    startError.code === "uncommitted_changes";

  function startWorkflow(
    item: TemplateLibraryItem,
    parameters: Record<string, string> | undefined,
  ): void {
    setAwaitingApproval(null);
    startMutation.mutate(
      {
        definitionId: item.id,
        definitionRevision: item.revision,
        tier: item.tier,
        ...(parameters !== undefined ? { parameters } : {}),
      },
      {
        onSuccess: (result) => {
          setAwaitingApproval(
            result.kind === "awaiting_approval" ? result : null,
          );
          setLaunchItem(null);
          setEngineError(null);
        },
        onError: (error) => {
          if (
            error instanceof ApiCallError &&
            error.code === "uncommitted_changes"
          ) {
            setUncommittedMessage(error.message);
            setLaunchItem(null);
            return;
          }
          // Any other launch failure (e.g. a 400 input-validation rejection)
          // belongs inside the open form so the offending parameter is named in
          // context.
          if (item.id === launchItem?.id) {
            setEngineError(
              error instanceof Error
                ? error.message
                : "Failed to start workflow",
            );
          }
        },
      },
    );
  }

  function handleRun(definition: DefinitionIdentity): void {
    const item = items.find(
      (candidate) =>
        candidate.id === definition.id && candidate.tier === definition.tier,
    );
    if (!item) return;
    // A parameterized template collects run-specific values in a modal first; a
    // zero-input template keeps the one-click behaviour (no parameters sent).
    if (item.parameters.length > 0) {
      setEngineError(null);
      setLaunchItem(item);
      return;
    }
    startWorkflow(item, undefined);
  }

  return (
    <>
      <GraphWorkflowLauncher
        projectName={projectName}
        sessionName={sessionName}
        definitions={items.map((i) => ({
          id: i.id,
          name: i.name,
          revision: i.revision,
          tier: i.tier,
        }))}
        loading={templatesQuery.isPending}
        starting={startMutation.isPending && launchItem === null}
        error={
          startMutation.isError && !isUncommittedBlock && launchItem === null
            ? startError instanceof Error
              ? startError.message
              : "Failed to start workflow"
            : null
        }
        onRun={handleRun}
        awaitingApproval={awaitingApproval}
      />
      <Dialog
        open={launchItem !== null}
        onOpenChange={(next) => {
          if (!next && !startMutation.isPending) {
            setLaunchItem(null);
            setEngineError(null);
          }
        }}
      >
        {launchItem !== null && (
          <DialogContent
            aria-label="Launch workflow"
            onInteractOutside={(event) => {
              if (startMutation.isPending) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (startMutation.isPending) event.preventDefault();
            }}
          >
            <WorkflowLaunchForm
              parameters={launchItem.parameters}
              isLaunching={startMutation.isPending}
              engineError={engineError}
              onLaunch={(values) => startWorkflow(launchItem, values)}
              onCancel={() => {
                setLaunchItem(null);
                setEngineError(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
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
