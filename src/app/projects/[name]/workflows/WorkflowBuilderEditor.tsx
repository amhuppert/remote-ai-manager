"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import type {
  CodexConfig,
  GraphWorkflowAgentConfig,
  WorkflowDefinitionRecord,
} from "@/types";
import {
  addExecutionContext,
  deleteExecutionContext,
} from "@/lib/workflow-graph/builder-draft";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import { collectNodeDimensions } from "@/components/workflow-graph/AutoLayout";
import { validateWorkflowDefinition } from "@/lib/workflow-graph/validation";
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
  onSave?: (draft: {
    definition: WorkflowDefinitionRecord["definition"];
    layout: WorkflowDefinitionRecord["layout"];
  }) => void | Promise<void>;
  saveError?: string | null;
  defaultImplementerConfig?: GraphWorkflowAgentConfig;
  codexConfig?: CodexConfig;
  isMobile?: boolean;
  onAutoSwitchPanel?: (panel: BuilderMobilePanel) => void;
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
  onSave,
  saveError,
  defaultImplementerConfig,
  codexConfig,
  isMobile,
  onAutoSwitchPanel,
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

    const validation = validateWorkflowDefinition(draftDefinition);
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
    const result = addExecutionContext(
      { definition: draftDefinition, layout: draftLayout },
      { defaultAgentConfig: defaultImplementerConfig },
    );
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
    <div className="wb-editor">
      <WorkflowToolbar
        workflowName={workflowName}
        revision={revision}
        onRename={onRename}
        onDelete={onDelete}
        onAddContext={handleAddContext}
        onSave={() => void handleSave()}
        onReset={handleReset}
        onRelayout={handleRelayout}
        dirty={dirty}
        saving={isSaving}
        hasValidationErrors={validationErrors.length > 0}
        isMobile={isMobile}
      />
      {saveError && <div className="wb-save-error-banner">{saveError}</div>}
      <div className="wb-editor-body">
        <WorkflowBuilderCanvas onSelectContext={handleSelectContext} />
        <WorkflowInspectorPanel
          onSave={handleSave}
          onDelete={handleDeleteContext}
          saving={isSaving}
          defaultImplementerConfig={defaultImplementerConfig}
          codexConfig={codexConfig}
        />
      </div>
    </div>
  );
}
