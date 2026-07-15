"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import { formatWorkflowSaveError } from "@/features/workflows-builder/format-save-error";
import {
  useScopedCreateWorkflowDefinitionMutation,
  useScopedDeleteWorkflowDefinitionMutation,
  useScopedUpdateWorkflowDefinitionMutation,
} from "@/lib/workflows/mutations";
import {
  useScopedWorkflowDefinitionQuery,
  useScopedWorkflowDefinitionsQuery,
} from "@/lib/workflows/queries";
import type { WorkflowDefinitionScope } from "@/lib/workflows/definition-scope";
import { useWorkflowMobilePanel } from "@/components/workflow-graph/useWorkflowMobilePanel";
import { WorkflowMobileTabBar } from "@/components/workflow-graph/WorkflowMobileTabBar";
import { useGlobalDefaults } from "@/hooks/use-global-defaults";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { CodexConfig } from "@/lib/agent-backends/schemas";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowVisualLayout,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type { BuilderMobilePanel } from "./WorkflowBuilderEditor";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";
import type { InspectorTab } from "./WorkflowInspectorPanel";

interface ConnectedWorkflowBuilderPageProps {
  scope: WorkflowDefinitionScope;
  defaultImplementerConfig: GraphWorkflowAgentConfig;
  codexConfig?: CodexConfig;
}

// A new builder draft starts charter-less from the user's point of view; the
// schema now requires one, so the empty draft carries a placeholder until the
// author fills it in. Charter authoring in the builder UI is owned by a later
// task.
const placeholderCharter: WorkflowCharter = {
  mission: "Describe this workflow's mission",
  sourcesOfTruth: [
    {
      rank: 1,
      id: "objective",
      label: "Workflow objective",
      type: "document",
      locator: "objective",
      description: "The stated objective for this workflow",
      accessPolicy: "worktree-relative",
    },
  ],
};

const emptyDefinition: WorkflowSemanticDefinition = {
  schemaVersion: 1,
  workflowConfig: {},
  charter: placeholderCharter,
  parameters: [],
  prerequisites: [],
  executionContexts: [],
  tasks: [],
  edges: [],
};

const emptyLayout: GraphWorkflowVisualLayout = {
  workflowId: "draft",
  contextPositions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
};

export function resolveDefinitionClientSide(
  globalDefaults: WorkflowDefaults,
  definition: WorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  return resolveWorkflowDefinition(
    { workflowDefaults: globalDefaults } as GlobalConfig,
    definition,
  );
}

export default function ConnectedWorkflowBuilderPage({
  scope,
  defaultImplementerConfig,
  codexConfig,
}: ConnectedWorkflowBuilderPageProps): React.JSX.Element {
  const isGlobal = scope.kind === "global";
  const projectName = scope.kind === "project" ? scope.projectName : null;
  const { isMobile, mobilePanel, setMobilePanel, autoSwitchPanel } =
    useWorkflowMobilePanel<BuilderMobilePanel>("graph");
  const definitionsQuery = useScopedWorkflowDefinitionsQuery(scope);
  const { workflowDefaults } = useGlobalDefaults();
  const [requestedWorkflowId, setRequestedWorkflowId] = useState<string | null>(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>("workflow");
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (s) => s.selectedContextId,
  );
  const [prevSelectedContextId, setPrevSelectedContextId] = useState<
    string | null
  >(selectedContextId);

  if (selectedContextId !== prevSelectedContextId) {
    setPrevSelectedContextId(selectedContextId);
    if (selectedContextId) {
      setActiveTab("context");
    }
  }

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
  const selectedRecord = useScopedWorkflowDefinitionQuery(
    scope,
    selectedWorkflowId,
  );
  const createMutation = useScopedCreateWorkflowDefinitionMutation(scope);
  const updateMutation = useScopedUpdateWorkflowDefinitionMutation(
    scope,
    selectedWorkflowId ?? "",
  );
  const deleteMutation = useScopedDeleteWorkflowDefinitionMutation(scope);

  const selectedSummary = useMemo(() => {
    return (
      definitionsQuery.data?.find((item) => item.id === selectedWorkflowId) ??
      null
    );
  }, [definitionsQuery.data, selectedWorkflowId]);

  function handleSelectDefinition(id: string): void {
    setRequestedWorkflowId(id);
    setSaveError(null);
    autoSwitchPanel("graph");
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
    autoSwitchPanel("graph");
  }

  async function handleSaveDraft(draft: {
    definition: WorkflowSemanticDefinition;
    layout: GraphWorkflowVisualLayout;
  }): Promise<void> {
    const item = selectedRecord.data?.item;
    if (!item) {
      return;
    }

    try {
      await updateMutation.mutateAsync({
        name: item.name,
        description: item.description,
        definition: draft.definition,
        layout: draft.layout,
      });
      setSaveError(null);
    } catch (error) {
      setSaveError(formatWorkflowSaveError(error));
      throw error;
    }
  }

  async function handleRenameWorkflow(name: string): Promise<void> {
    const item = selectedRecord.data?.item;
    if (!item) return;

    try {
      await updateMutation.mutateAsync({
        name,
        description: item.description,
        definition: item.definition,
        layout: item.layout,
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
    <div
      className="app"
      data-page="workflow-builder"
      data-mobile-panel={mobilePanel}
    >
      <Topbar
        page="sessions"
        breadcrumbs={
          isGlobal || projectName === null
            ? [
                { label: "templates", href: "/templates" },
                { label: "global-builder" },
              ]
            : [
                { label: "projects", href: "/projects" },
                {
                  label: projectName,
                  href: `/projects/${encodeURIComponent(projectName)}`,
                },
                { label: "workflow-builder" },
              ]
        }
      />
      <WorkRailMain
        {...(projectName !== null ? { projectName } : {})}
        contentClassName="flex flex-col overflow-hidden max-768:pb-[calc(56px+env(safe-area-inset-bottom,0px))]"
      >
        <div className="flex h-full min-h-0 flex-1 max-768:flex-col">
          <WorkflowDefinitionsSidebar
            title={isGlobal ? "Global Templates" : "Definitions"}
            definitions={definitionsQuery.data ?? []}
            selectedId={selectedWorkflowId}
            onSelect={handleSelectDefinition}
            onCreate={() => void handleCreateWorkflow()}
            isLoading={definitionsQuery.isPending}
            isCreating={createMutation.isPending}
            footer={
              <Link
                className="flex items-center gap-[6px] px-0 py-[6px] text-[0.72rem] font-medium text-text-secondary no-underline transition-colors duration-150 hover:text-text-primary"
                href={
                  projectName === null
                    ? "/projects"
                    : `/projects/${encodeURIComponent(projectName)}`
                }
              >
                {projectName === null
                  ? "← Back to Projects"
                  : "← Back to Sessions"}
              </Link>
            }
          />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-768:min-w-0 max-768:flex-1 max-768:[.app[data-page=workflow-builder][data-mobile-panel=definitions]_&]:hidden">
            {selectedWorkflowId === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
                <span className="text-[0.82rem] font-medium">
                  Select or create a workflow
                </span>
              </div>
            ) : selectedRecord.isPending ? (
              <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
                <span className="text-[0.82rem] font-medium">
                  Loading workflow editor...
                </span>
              </div>
            ) : selectedRecord.data ? (
              <WorkflowBuilderEditor
                onSave={handleSaveDraft}
                record={selectedRecord.data.item}
                workflowName={selectedRecord.data.item.name}
                revision={selectedSummary?.revision ?? null}
                onRename={(name) => void handleRenameWorkflow(name)}
                onDelete={() => void handleDeleteWorkflow()}
                deleting={deleteMutation.isPending}
                saveError={saveError}
                defaultImplementerConfig={defaultImplementerConfig}
                codexConfig={codexConfig}
                globalDefaults={workflowDefaults}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                onOpenWorkflowSettings={() => setActiveTab("workflow")}
                isMobile={isMobile}
                onAutoSwitchPanel={autoSwitchPanel}
                voiceProjectName={projectName}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
                <span className="text-[0.82rem] font-medium">
                  Workflow not found
                </span>
              </div>
            )}
          </div>
        </div>
      </WorkRailMain>
      {isMobile && (
        <WorkflowMobileTabBar<BuilderMobilePanel>
          tabs={builderMobileTabs}
          activePanel={mobilePanel}
          onChange={setMobilePanel}
        />
      )}
    </div>
  );
}

const builderMobileTabs = [
  { value: "graph" as const, label: "Graph" },
  { value: "definitions" as const, label: "Defs" },
  { value: "inspector" as const, label: "Inspector" },
];
