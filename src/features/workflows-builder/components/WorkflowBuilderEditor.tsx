"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import type { ConfigScope } from "@/components/workflow-config-panel/types";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  WorkflowDefinitionRecord,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import { cn } from "@/lib/ui/cn";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";
import type { ReactNode } from "react";
import {
  addExecutionContext,
  deleteExecutionContext,
} from "@/lib/workflow-graph/builder-draft";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import { collectNodeDimensions } from "@/components/workflow-graph/AutoLayout";
import { validateAuthoredDefinition } from "@/lib/workflow-graph/definition-validation";
import {
  railOverlayPanelClass,
  RailOverlaySpacer,
} from "@/components/workflow-graph/RailOverlay";
import { useWorkflowRailCollapse } from "@/components/workflow-graph/useWorkflowRailCollapse";
import { MobilePanelVisibility } from "@/components/workflow-graph/mobile-panel-visibility";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import BuilderConfigPanel, {
  type BuilderConfigPanelFocus,
} from "./BuilderConfigPanel";
import { useOutputSchemaBlocks } from "./output-schema-drafts";
import WorkflowBuilderCanvas from "./WorkflowBuilderCanvas";
import WorkflowToolbar from "./WorkflowToolbar";
import WorkflowBuilderInspectorRail from "./native-sdd/WorkflowBuilderInspectorRail";
import {
  OUTPUT_SCHEMA_SCREEN_PATH,
  routeValidationError,
  validationErrorRowLabel,
  type ValidationErrorRoute,
} from "./validation-error-routing";

export type BuilderMobilePanel = "graph" | "definitions" | "inspector";

interface IssueRow {
  key: string;
  label: string;
  route: ValidationErrorRoute;
}

function issueRow(
  error: WorkflowGraphValidationError,
  index: number,
): IssueRow {
  return {
    key: `${error.code}:${error.contextId ?? ""}:${index}`,
    label: validationErrorRowLabel(error),
    route: routeValidationError(error),
  };
}

const ISSUE_ROW_TEXT = "text-left font-mono text-[0.72rem] leading-[1.55]";

const RAIL_ICON_BTN =
  "inline-flex size-[24px] flex-shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-bg-raised p-0 text-text-secondary transition-all duration-150 hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";

interface WorkflowBuilderEditorProps {
  record: WorkflowDefinitionRecord;
  workflowName: string;
  revision: number | null;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** True while the delete-definition mutation is in flight. */
  deleting?: boolean;
  onSave?: (draft: {
    definition: WorkflowDefinitionRecord["definition"];
    layout: WorkflowDefinitionRecord["layout"];
  }) => void | Promise<void>;
  saveError?: string | null;
  globalDefaults?: WorkflowDefaults;
  /** Which tier the right rail is editing. */
  configScope?: ConfigScope;
  onConfigScopeChange?: (scope: ConfigScope) => void;
  isMobile?: boolean;
  /** Which panel the bottom toolbar has on screen; `graph` below 768px. */
  mobilePanel?: BuilderMobilePanel;
  onAutoSwitchPanel?: (panel: BuilderMobilePanel) => void;
  /** Builder scope: registry source for command multi-selects (null = global). */
  projectName?: string | null;
  /** Scopes the agent-profile listing the assignment pickers offer. */
  libraryProjectName?: string | null;
  readOnly?: boolean;
  management?: NativeSddWorkflowManagementDetail;
  managedHeader?: ReactNode;
  onReaffirm?: (
    criterionElementIds: readonly string[],
    expectedBindingRevision: number,
  ) => void;
  reaffirming?: boolean;
  managedError?: string | null;
  onManagedComment?: (input: { contextId: string; body: string }) => void;
  commenting?: boolean;
}

export default function WorkflowBuilderEditor(
  props: WorkflowBuilderEditorProps,
): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowBuilderEditorInner({
  record,
  workflowName,
  revision,
  onRename,
  onDelete,
  deleting,
  onSave,
  saveError,
  globalDefaults,
  configScope = "workflow",
  onConfigScopeChange,
  isMobile,
  mobilePanel = "graph",
  onAutoSwitchPanel,
  projectName,
  libraryProjectName,
  readOnly = false,
  management,
  managedHeader,
  onReaffirm,
  reaffirming,
  managedError,
  onManagedComment,
  commenting,
}: WorkflowBuilderEditorProps): React.JSX.Element {
  const { getNodes } = useReactFlow();
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (s) => s.draftDefinition,
  );
  const draftLayout = _useGraphWorkflowBuilderStore((s) => s.draftLayout);
  const dirty = _useGraphWorkflowBuilderStore((s) => s.dirty);
  const loadPersistedDraft = _useGraphWorkflowBuilderStore(
    (s) => s.loadPersistedDraft,
  );
  const updateDefinition = _useGraphWorkflowBuilderStore(
    (s) => s.updateDefinition,
  );
  const updateLayout = _useGraphWorkflowBuilderStore((s) => s.updateLayout);
  const setSelectedContextId = _useGraphWorkflowBuilderStore(
    (s) => s.setSelectedContextId,
  );
  const markSaved = _useGraphWorkflowBuilderStore((s) => s.markSaved);
  const addEphemeralLane = _useGraphWorkflowBuilderStore(
    (s) => s.addEphemeralLane,
  );
  const resetToPersisted = _useGraphWorkflowBuilderStore(
    (s) => s.resetToPersisted,
  );
  const [isSaving, setIsSaving] = useState(false);
  const {
    collapsed: railCollapsed,
    setCollapsed: setRailCollapsed,
    overlay: railOverlay,
  } = useWorkflowRailCollapse();
  const [panelFocus, setPanelFocus] = useState<BuilderConfigPanelFocus | null>(
    null,
  );
  // Output-schema text outside the engine's supported subset never reaches the
  // store, so `dirty` cannot see it and no verdict about the draft can raise
  // it. Both save controls route through THIS component's `handleSave`, so the
  // gate lives here — inside the panel alone it would leave the toolbar free to
  // persist the last valid schema and report the draft saved.
  const outputSchemaBlocks = useOutputSchemaBlocks();
  const outputSchemaBlocked = outputSchemaBlocks.length > 0;

  // README §5: the toolbar status IS the definition validation — there is no
  // separate Validate action — so the verdict has to track the draft rather
  // than freeze at the last save attempt. A frozen verdict would refuse Save
  // forever, because the fix it asked for could never be re-checked, and the
  // strip an author is working through would be a list of already-fixed rows.
  const draftErrors = useMemo(
    () =>
      draftDefinition === null
        ? []
        : validateAuthoredDefinition(draftDefinition).errors,
    [draftDefinition],
  );
  // An edit the canvas refused (§2.1) was never applied: the draft is unchanged
  // and may well be perfectly savable. It is feedback about ONE attempt, shown
  // apart from the draft's own errors and retired by the next accepted edit —
  // gating Save on it would strand a valid draft on a rejected gesture.
  const refusedEdits = _useGraphWorkflowBuilderStore((s) => s.refusedEdits);

  useEffect(() => {
    loadPersistedDraft({
      definition: record.definition,
      layout: record.layout,
    });
  }, [
    loadPersistedDraft,
    record.definition,
    record.layout,
    record.id,
    record.revision,
  ]);

  async function handleSave() {
    if (!onSave || !draftDefinition || !draftLayout || outputSchemaBlocked) {
      return;
    }

    // The same accept-time validation the storage choke point applies
    // (parameter shape checks + placeholder/reference lint + structural graph
    // validation) already drives the strip and the disabled Save. Re-running it
    // here keeps the refusal fail-closed for any path that reaches the handler
    // without the button — the mobile menu, a stale render — rather than
    // trusting the gate that hid it.
    if (!validateAuthoredDefinition(draftDefinition).ok) return;

    setIsSaving(true);
    try {
      await onSave({ definition: draftDefinition, layout: draftLayout });
      markSaved({ definition: draftDefinition, layout: draftLayout });
    } catch {
      // Page-level error state handles this via saveError prop
    } finally {
      setIsSaving(false);
    }
  }

  function handleAddContext() {
    if (!draftDefinition || !draftLayout) return;
    const result = addExecutionContext({
      definition: draftDefinition,
      layout: draftLayout,
    });
    updateDefinition(result.definition);
    updateLayout(result.layout);
    setSelectedContextId(result.contextId);
    onConfigScopeChange?.("context");
    setRailCollapsed(false);
    onAutoSwitchPanel?.("inspector");
  }

  function handleReset() {
    resetToPersisted();
  }

  function handleRelayout() {
    if (!draftDefinition) return;
    const dims = collectNodeDimensions(getNodes());
    const newLayout = generateWorkflowLayout(
      draftDefinition,
      null,
      dims.size > 0 ? dims : undefined,
    );
    updateLayout(newLayout);
  }

  function handleOpenWorkflowSettings() {
    onConfigScopeChange?.("workflow");
    setRailCollapsed(false);
    onAutoSwitchPanel?.("inspector");
  }

  function handleDeleteContext(contextId: string) {
    if (!draftDefinition || !draftLayout) return;
    const result = deleteExecutionContext(
      { definition: draftDefinition, layout: draftLayout },
      contextId,
    );
    updateDefinition(result.definition);
    updateLayout(result.layout);
    setSelectedContextId(null);
  }

  const handleSelectContext = useCallback(
    (id: string | null) => {
      if (id) onAutoSwitchPanel?.("inspector");
    },
    [onAutoSwitchPanel],
  );

  /**
   * Opening the editor that can clear one row. The panel's navigation stack is
   * its own state, so a deep link is a remount request carrying the path — and
   * the request id changes on every click so re-opening the same row works.
   */
  function handleOpenValidationRow(route: ValidationErrorRoute) {
    if (route.contextId !== null) setSelectedContextId(route.contextId);
    onConfigScopeChange?.(route.scope);
    setRailCollapsed(false);
    onAutoSwitchPanel?.("inspector");
    setPanelFocus((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      screenPath: route.screenPath,
    }));
  }

  // Everything standing between the author and a saved draft (README §5): the
  // validator's verdict on the draft, and the schema text no commit could
  // accept — which the store never sees, so only this list carries it.
  const validationRows: IssueRow[] = [
    ...draftErrors.map(issueRow),
    ...outputSchemaBlocks.map((block) => ({
      key: `output-schema:${block.contextId}`,
      label: `${block.contextId} · outputSchema — ${block.message}`,
      route: {
        contextId: block.contextId,
        scope: "context" as const,
        screenPath: OUTPUT_SCHEMA_SCREEN_PATH,
      },
    })),
  ];
  const refusedRows: IssueRow[] = refusedEdits.map(issueRow);
  const hasValidationErrors = validationRows.length > 0;

  function renderIssueList(
    label: string,
    rows: IssueRow[],
    listClassName: string,
    rowClassName: string,
  ): React.JSX.Element {
    return (
      <ul
        aria-label={label}
        className={cn(
          "m-0 flex list-none flex-col gap-[5px] border-x-0 border-t-0 border-b border-solid px-md py-[9px]",
          listClassName,
        )}
      >
        {rows.map((row) => (
          <li key={row.key} className="flex">
            {row.route.contextId === null &&
            row.route.screenPath.length === 0 ? (
              // Nothing in the panel can clear this one — an edge, a cycle,
              // a shape. A control that opened the root would be a dead
              // affordance, so the row simply states it.
              <span className={cn(ISSUE_ROW_TEXT, rowClassName)}>
                {row.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleOpenValidationRow(row.route)}
                className={cn(
                  ISSUE_ROW_TEXT,
                  rowClassName,
                  "cursor-pointer rounded-sm border-0 bg-transparent p-0 underline decoration-transparent underline-offset-2 transition-colors duration-150 hover:decoration-current focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:min-h-[44px]",
                )}
              >
                {row.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {managedHeader}
      <WorkflowToolbar
        workflowName={workflowName}
        revision={revision}
        onRename={onRename}
        onDelete={onDelete}
        onAddContext={handleAddContext}
        onNewLane={addEphemeralLane}
        onSave={() => void handleSave()}
        onReset={handleReset}
        onRelayout={handleRelayout}
        onOpenWorkflowSettings={handleOpenWorkflowSettings}
        dirty={dirty || outputSchemaBlocked}
        saving={isSaving}
        deleting={deleting}
        hasValidationErrors={hasValidationErrors}
        saveBlocked={outputSchemaBlocked}
        isMobile={isMobile}
        readOnly={readOnly}
        hideDelete={management !== undefined}
      />
      {hasValidationErrors &&
        renderIssueList(
          "Validation errors",
          validationRows,
          "border-b-[var(--cc-red-a15)] bg-[var(--cc-red-a10)]",
          "text-red",
        )}
      {refusedRows.length > 0 &&
        renderIssueList(
          "Refused edits",
          refusedRows,
          "border-b-[var(--cc-amber-border-subtle)] bg-[var(--cc-amber-bg-subtle)]",
          "text-amber",
        )}
      {saveError && (
        <div className="border-b border-solid border-b-[var(--cc-red-a15)] bg-[var(--cc-red-a06)] px-md py-sm font-mono text-[0.72rem] leading-[1.4] whitespace-pre-line text-red">
          {saveError}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 max-768:flex-col">
        <WorkflowBuilderCanvas
          onSelectContext={handleSelectContext}
          globalDefaults={globalDefaults}
          isMobile={isMobile === true}
          readOnly={readOnly}
        />
        {railOverlay && <RailOverlaySpacer side="right" stripWidth="48" />}
        <aside
          aria-label="Configuration"
          className={cn(
            "flex min-h-0 flex-col border-l border-solid border-border-subtle bg-bg-surface",
            // Positioned either way: the collapse chevron hangs off the rail's
            // own left edge, so the rail has to be the containing block.
            railOverlay ? railOverlayPanelClass("right") : "relative",
            // §2.4: 420px is the one approved width exception — the rail is
            // that width at every desktop size, and becomes a full-width panel
            // only where the mobile layout takes over.
            railCollapsed ? "w-[48px] min-w-[48px]" : "w-[420px] min-w-[420px]",
            "max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow-builder][data-mobile-panel=definitions]_&]:hidden max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden",
          )}
        >
          {railCollapsed ? (
            <div className="flex flex-col items-center gap-[6px] py-[10px]">
              <button
                type="button"
                className={RAIL_ICON_BTN}
                onClick={() => setRailCollapsed(false)}
                aria-label="Expand configuration panel"
                title="Expand configuration panel"
              >
                <ChevronLeftIcon size={13} />
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={cn(
                  RAIL_ICON_BTN,
                  "absolute top-[10px] left-[-13px] z-10 max-768:hidden",
                )}
                onClick={() => setRailCollapsed(true)}
                aria-label="Collapse configuration panel"
                title="Collapse configuration panel"
              >
                <ChevronRightIcon size={13} />
              </button>
              <MobilePanelVisibility
                onScreen={isMobile !== true || mobilePanel === "inspector"}
              >
                {management ? (
                  <WorkflowBuilderInspectorRail
                    management={management}
                    config={
                      <BuilderConfigPanel
                        workflowName={workflowName}
                        scope={configScope}
                        onScopeChange={(next) => onConfigScopeChange?.(next)}
                        globalDefaults={globalDefaults}
                        projectName={projectName}
                        libraryProjectName={libraryProjectName}
                        onDeleteContext={handleDeleteContext}
                        focus={panelFocus}
                        readOnly={readOnly}
                      />
                    }
                    onReaffirm={onReaffirm}
                    reaffirming={reaffirming}
                    error={managedError}
                    onComment={onManagedComment}
                    commenting={commenting}
                  />
                ) : (
                  <BuilderConfigPanel
                    workflowName={workflowName}
                    scope={configScope}
                    onScopeChange={(next) => onConfigScopeChange?.(next)}
                    globalDefaults={globalDefaults}
                    projectName={projectName}
                    libraryProjectName={libraryProjectName}
                    onDeleteContext={handleDeleteContext}
                    focus={panelFocus}
                    readOnly={readOnly}
                  />
                )}
              </MobilePanelVisibility>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
