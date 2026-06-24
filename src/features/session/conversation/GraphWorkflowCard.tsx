"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import type {
  GraphWorkflowExecution,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import type {
  TemplateLibraryItem,
  TemplateTier,
} from "@/lib/workflow-graph/template-library-service";
import { useProjectTemplatesQuery } from "@/lib/workflows/queries";
import { useStartGraphWorkflowMutation } from "@/lib/workflows/mutations";
import { ApiCallError } from "@/lib/api/errors";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/ModalShell";
import WorkflowLaunchForm from "@/components/WorkflowLaunchForm";
import { cn } from "@/lib/ui/cn";

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

function ChevronDown({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn(
        "size-[14px] shrink-0 text-text-tertiary transition-transform duration-150 ease-[ease]",
        open && "rotate-180",
      )}
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
}: {
  projectName: string;
  sessionName: string;
  definitions: DefinitionSummary[];
  loading?: boolean;
  starting?: boolean;
  error?: string | null;
  onRun?: (definitionId: string) => void;
  /** Reports the currently selected definition id (null when cleared). */
  onSelectionChange?: (definitionId: string | null) => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const templatesHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/templates`;
  const workflowsHref = `/projects/${encodeURIComponent(projectName)}/workflows`;
  const selected = definitions.find((d) => d.id === selectedId) ?? null;

  // The popover is portaled to <body> so a later sibling card in the conversation
  // feed can't paint over it (z-index only competes within a stacking context);
  // position it under the trigger from the trigger's viewport rect.
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuStyle({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  // Keep the portaled popover pinned to the trigger as the feed scrolls/resizes.
  useEffect(() => {
    if (!open) return;
    const reposition = (): void => updatePosition();
    window.addEventListener("scroll", reposition, { capture: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
  }, [open, updatePosition]);

  // Escape-to-close + background-hotkey suppression while the menu is open.
  useOverlayScope(open, { onEscape: () => setOpen(false) });

  // Click-outside dismissal \u2014 the popover is portaled out of the trigger's
  // container, so dismiss only when the click is outside BOTH the trigger and
  // the popover (capture phase so a child stopping propagation still dismisses).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (triggerWrapRef.current?.contains(target)) return;
      if (listboxRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    return () =>
      document.removeEventListener("mousedown", onMouseDown, { capture: true });
  }, [open]);

  function selectDefinition(definitionId: string): void {
    setSelectedId(definitionId);
    onSelectionChange?.(definitionId);
    setOpen(false);
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
      {/* Collapsed dropdown \u2014 a long template list scrolls inside the popover
          rather than growing the card; the popover is portaled to <body>. */}
      <div ref={triggerWrapRef}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-sm rounded-md border border-solid border-border-default bg-bg-base px-sm py-[8px] text-left font-mono text-[0.8rem] transition-[border-color,box-shadow] duration-150 ease-[ease] outline-none hover:border-border-strong focus-visible:border-cyan focus-visible:shadow-[0_0_0_1px_var(--color-cyan-glow)]"
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
          <ChevronDown open={open} />
        </button>
      </div>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={listboxRef}
            role="listbox"
            style={menuStyle}
            className="fixed z-popover max-h-[244px] overflow-y-auto rounded-md border border-solid border-border-default bg-bg-elevated p-[4px] shadow-menu"
          >
            {definitions.map((d) => {
              const isSelected = d.id === selectedId;
              return (
                <button
                  key={`${d.tier}:${d.id}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectDefinition(d.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-sm rounded-sm border-0 bg-transparent px-sm py-[8px] text-left font-mono text-[0.78rem] transition-colors duration-150 ease-[ease] hover:bg-bg-hover",
                    isSelected
                      ? "bg-bg-raised text-text-primary"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  {tierBadge(d.tier)}
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="shrink-0 text-[0.7rem] text-text-tertiary">
                    rev {d.revision}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}

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
          disabled={!selectedId || starting}
          onClick={() => selectedId && onRun?.(selectedId)}
          type="button"
        >
          {starting ? "Starting\u2026" : "Run Workflow"}
        </Button>
      </div>
      {error && (
        <div className="mt-xs font-mono text-[0.72rem] text-red">{error}</div>
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

  const items = templatesQuery.data ?? [];

  const startError = startMutation.error;
  const isUncommittedBlock =
    startError instanceof ApiCallError &&
    startError.code === "uncommitted_changes";

  function startWorkflow(
    item: TemplateLibraryItem,
    parameters: Record<string, string> | undefined,
  ): void {
    startMutation.mutate(
      {
        definitionId: item.id,
        tier: item.tier,
        ...(parameters !== undefined ? { parameters } : {}),
      },
      {
        onSuccess: () => {
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

  function handleRun(definitionId: string): void {
    const item = items.find((i) => i.id === definitionId);
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
      />
      {launchItem !== null && (
        <ModalShell
          role="dialog"
          aria-modal="true"
          aria-label="Launch workflow"
          overlayProps={{
            onClick: () => {
              if (!startMutation.isPending) setLaunchItem(null);
            },
          }}
          onClick={(event) => event.stopPropagation()}
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
        </ModalShell>
      )}
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
