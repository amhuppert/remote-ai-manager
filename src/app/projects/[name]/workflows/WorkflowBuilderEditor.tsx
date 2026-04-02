"use client";

import { useEffect, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import type {
  ClaudeModel,
  CodexConfig,
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
  defaultModel?: ClaudeModel;
  codexConfig?: CodexConfig;
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
  defaultModel,
  codexConfig,
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
      { defaultModel },
    );
    updateDefinition(result.definition);
    updateLayout(result.layout);
    setSelectedContextId(result.contextId);
    setValidationErrors([]);
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
      />
      {saveError && (
        <div
          style={{
            padding: "var(--space-sm) var(--space-md)",
            color: "var(--red)",
            fontSize: "0.72rem",
            background: "rgba(255,61,90,0.06)",
            borderBottom: "1px solid rgba(255,61,90,0.15)",
          }}
        >
          {saveError}
        </div>
      )}
      <div className="wb-editor-body">
        <WorkflowBuilderCanvas />
        <WorkflowInspectorPanel
          onSave={handleSave}
          onDelete={handleDeleteContext}
          saving={isSaving}
          defaultModel={defaultModel}
          codexConfig={codexConfig}
        />
      </div>
    </div>
  );
}
