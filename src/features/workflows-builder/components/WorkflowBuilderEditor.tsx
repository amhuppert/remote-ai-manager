"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import type { CodexConfig } from "@/lib/agent-backends/schemas";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowAgentConfig,
  WorkflowDefinitionRecord,
} from "@/lib/workflows/schemas";
import type { InspectorTab } from "./WorkflowInspectorPanel";
import {
  addExecutionContext,
  deleteExecutionContext,
} from "@/lib/workflow-graph/builder-draft";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import { collectNodeDimensions } from "@/components/workflow-graph/AutoLayout";
import { validateAuthoredDefinition } from "@/lib/workflow-graph/validation";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import WorkflowBuilderCanvas from "./WorkflowBuilderCanvas";
import WorkflowInspectorPanel from "./WorkflowInspectorPanel";
import WorkflowToolbar from "./WorkflowToolbar";

export type BuilderMobilePanel = "graph" | "definitions" | "inspector";

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
  defaultImplementerConfig?: GraphWorkflowAgentConfig;
  codexConfig?: CodexConfig;
  globalDefaults?: WorkflowDefaults;
  activeTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
  onOpenWorkflowSettings?: () => void;
  isMobile?: boolean;
  onAutoSwitchPanel?: (panel: BuilderMobilePanel) => void;
  voiceProjectName?: string | null;
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
  defaultImplementerConfig,
  codexConfig,
  globalDefaults,
  activeTab,
  onTabChange,
  onOpenWorkflowSettings,
  isMobile,
  onAutoSwitchPanel,
  voiceProjectName,
}: WorkflowBuilderEditorProps): React.JSX.Element {
  const { getNodes } = useReactFlow();
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (s) => s.draftDefinition,
  );
  const draftLayout = _useGraphWorkflowBuilderStore((s) => s.draftLayout);
  const dirty = _useGraphWorkflowBuilderStore((s) => s.dirty);
  const validationErrors = _useGraphWorkflowBuilderStore(
    (s) => s.validationErrors,
  );
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
  const setValidationErrors = _useGraphWorkflowBuilderStore(
    (s) => s.setValidationErrors,
  );
  const markSaved = _useGraphWorkflowBuilderStore((s) => s.markSaved);
  const resetToPersisted = _useGraphWorkflowBuilderStore(
    (s) => s.resetToPersisted,
  );
  const [isSaving, setIsSaving] = useState(false);

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
    if (!onSave || !draftDefinition || !draftLayout) return;

    // Run the SAME accept-time validation the storage choke point applies
    // (parameter shape checks + placeholder/reference lint + structural graph
    // validation). Routing the builder save through it lands the rich
    // parameter lint errors — each carrying its offending field and undeclared
    // name — in the store so the parameter editor surfaces them on save (R8.3),
    // instead of only the comma-joined codes the server throw produces.
    const validation = validateAuthoredDefinition(draftDefinition);
    if (!validation.ok) {
      setValidationErrors(validation.errors);
      return;
    }
    setValidationErrors([]);

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
    setValidationErrors([]);
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

  function handleDeleteContext(contextId: string) {
    if (!draftDefinition || !draftLayout) return;
    const result = deleteExecutionContext(
      { definition: draftDefinition, layout: draftLayout },
      contextId,
    );
    updateDefinition(result.definition);
    updateLayout(result.layout);
    setSelectedContextId(null);
    setValidationErrors([]);
  }

  const handleSelectContext = useCallback(
    (id: string | null) => {
      if (id) onAutoSwitchPanel?.("inspector");
    },
    [onAutoSwitchPanel],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowToolbar
        workflowName={workflowName}
        revision={revision}
        onRename={onRename}
        onDelete={onDelete}
        onAddContext={handleAddContext}
        onSave={() => void handleSave()}
        onReset={handleReset}
        onRelayout={handleRelayout}
        onOpenWorkflowSettings={onOpenWorkflowSettings}
        dirty={dirty}
        saving={isSaving}
        deleting={deleting}
        hasValidationErrors={validationErrors.length > 0}
        isMobile={isMobile}
      />
      {saveError && (
        <div className="border-b border-solid border-b-[var(--cc-red-a15)] bg-[var(--cc-red-a06)] px-md py-sm font-mono text-[0.72rem] leading-[1.4] whitespace-pre-line text-red">
          {saveError}
        </div>
      )}
      <div className="flex min-h-0 flex-1 max-768:flex-col">
        <WorkflowBuilderCanvas
          onSelectContext={handleSelectContext}
          globalDefaults={globalDefaults}
        />
        <WorkflowInspectorPanel
          onSave={handleSave}
          onDelete={handleDeleteContext}
          saving={isSaving}
          defaultImplementerConfig={defaultImplementerConfig}
          codexConfig={codexConfig}
          globalDefaults={globalDefaults}
          activeTab={activeTab}
          onTabChange={onTabChange}
          voiceProjectName={voiceProjectName}
        />
      </div>
    </div>
  );
}
