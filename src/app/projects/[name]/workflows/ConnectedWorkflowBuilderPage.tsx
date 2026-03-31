"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import Topbar from "@/components/Topbar";
import { ApiCallError } from "@/lib/api-client";
import {
  useCreateWorkflowDefinitionMutation,
  useDeleteWorkflowDefinitionMutation,
  useUpdateWorkflowDefinitionMutation,
} from "@/lib/mutations";
import {
  useWorkflowDefinitionQuery,
  useWorkflowDefinitionsQuery,
} from "@/lib/queries";
import type {
  ClaudeModel,
  GraphWorkflowVisualLayout,
  WorkflowSemanticDefinition,
} from "@/types";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";

interface ConnectedWorkflowBuilderPageProps {
  projectName: string;
  defaultModel: ClaudeModel;
}

const emptyDefinition: WorkflowSemanticDefinition = {
  schemaVersion: 1,
  executionContexts: [],
  tasks: [],
  edges: [],
};

const emptyLayout: GraphWorkflowVisualLayout = {
  workflowId: "draft",
  contextPositions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
};

export default function ConnectedWorkflowBuilderPage({
  projectName,
  defaultModel,
}: ConnectedWorkflowBuilderPageProps): React.JSX.Element {
  const definitionsQuery = useWorkflowDefinitionsQuery(projectName);
  const [requestedWorkflowId, setRequestedWorkflowId] = useState<string | null>(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedWorkflowId = useMemo(() => {
    const definitions = definitionsQuery.data;
    if (!definitions || definitions.length === 0) {
      return null;
    }

    if (
      requestedWorkflowId &&
      definitions.some((definition) => definition.id === requestedWorkflowId)
    ) {
      return requestedWorkflowId;
    }

    return definitions[0]?.id ?? null;
  }, [definitionsQuery.data, requestedWorkflowId]);
  const selectedRecord = useWorkflowDefinitionQuery(
    projectName,
    selectedWorkflowId,
  );
  const createMutation = useCreateWorkflowDefinitionMutation(projectName);
  const updateMutation = useUpdateWorkflowDefinitionMutation(
    projectName,
    selectedWorkflowId ?? "",
  );
  const deleteMutation = useDeleteWorkflowDefinitionMutation(projectName);

  const selectedSummary = useMemo(() => {
    return (
      definitionsQuery.data?.find((item) => item.id === selectedWorkflowId) ??
      null
    );
  }, [definitionsQuery.data, selectedWorkflowId]);

  function handleSelectDefinition(id: string): void {
    setRequestedWorkflowId(id);
    setSaveError(null);
  }

  async function handleCreateWorkflow(): Promise<void> {
    const nextNumber = (definitionsQuery.data?.length ?? 0) + 1;
    const created = await createMutation.mutateAsync({
      name: `Workflow ${nextNumber}`,
      description: null,
      definition: emptyDefinition,
      layout: emptyLayout,
    });
    setSaveError(null);
    setRequestedWorkflowId(created.item.id);
  }

  async function handleSaveDraft(draft: {
    definition: WorkflowSemanticDefinition;
    layout: GraphWorkflowVisualLayout;
  }): Promise<void> {
    if (!selectedRecord.data) {
      return;
    }

    try {
      await updateMutation.mutateAsync({
        name: selectedRecord.data.name,
        description: selectedRecord.data.description,
        definition: draft.definition,
        layout: draft.layout,
      });
      setSaveError(null);
    } catch (error) {
      setSaveError(
        error instanceof ApiCallError
          ? error.message
          : "Failed to save workflow draft",
      );
      throw error;
    }
  }

  async function handleRenameWorkflow(name: string): Promise<void> {
    if (!selectedRecord.data) return;

    try {
      await updateMutation.mutateAsync({
        name,
        description: selectedRecord.data.description,
        definition: selectedRecord.data.definition,
        layout: selectedRecord.data.layout,
      });
    } catch {
      // Rename failure is non-critical — the old name stays
    }
  }

  async function handleDeleteWorkflow(): Promise<void> {
    if (!selectedWorkflowId) {
      return;
    }

    await deleteMutation.mutateAsync(selectedWorkflowId);
    setSaveError(null);
    setRequestedWorkflowId(null);
  }

  return (
    <div className="app" data-page="workflow-builder">
      <Topbar
        page="sessions"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: "workflow-builder",
          },
        ]}
      />
      <main className="main">
        <div className="wb-page">
          <WorkflowDefinitionsSidebar
            definitions={definitionsQuery.data ?? []}
            selectedId={selectedWorkflowId}
            onSelect={handleSelectDefinition}
            onCreate={() => void handleCreateWorkflow()}
            isLoading={definitionsQuery.isPending}
            footer={
              <Link
                className="wb-sidebar-footer-link"
                href={`/projects/${encodeURIComponent(projectName)}`}
              >
                ← Back to Sessions
              </Link>
            }
          />

          <div className="wb-content">
            {selectedWorkflowId === null ? (
              <div className="wb-empty-state">
                <span className="wb-empty-state-text">
                  Select or create a workflow
                </span>
              </div>
            ) : selectedRecord.isPending ? (
              <div className="wb-empty-state">
                <span className="wb-empty-state-text">
                  Loading workflow editor...
                </span>
              </div>
            ) : selectedRecord.data ? (
              <WorkflowBuilderEditor
                onSave={handleSaveDraft}
                record={selectedRecord.data}
                workflowName={selectedRecord.data.name}
                revision={selectedSummary?.revision ?? null}
                onRename={(name) => void handleRenameWorkflow(name)}
                onDelete={() => void handleDeleteWorkflow()}
                saveError={saveError}
                defaultModel={defaultModel}
              />
            ) : (
              <div className="wb-empty-state">
                <span className="wb-empty-state-text">Workflow not found</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
