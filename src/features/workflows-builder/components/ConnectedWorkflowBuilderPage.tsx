"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { ChevronLeftIcon } from "@/components/icons";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import { formatWorkflowSaveError } from "@/features/workflows-builder/format-save-error";
import {
  useScopedCreateWorkflowDefinitionMutation,
  useScopedDeleteWorkflowDefinitionMutation,
  useScopedUpdateWorkflowDefinitionMutation,
} from "@/lib/workflows/mutations";
import {
  useScopedWorkflowDefinitionContextCounts,
  useScopedWorkflowDefinitionQuery,
  useScopedWorkflowDefinitionsQuery,
} from "@/lib/workflows/queries";
import {
  workflowDefinitionScopeApi,
  type WorkflowDefinitionScope,
} from "@/lib/workflows/definition-scope";
import { useWorkflowMobilePanel } from "@/components/workflow-graph/useWorkflowMobilePanel";
import { WorkflowMobileTabBar } from "@/components/workflow-graph/WorkflowMobileTabBar";
import { useGlobalDefaults } from "@/hooks/use-global-defaults";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowVisualLayout,
  CascadeWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { useOutputSchemaBlocks } from "./output-schema-drafts";
import type { BuilderMobilePanel } from "./WorkflowBuilderEditor";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";
import type { ConfigScope } from "@/components/workflow-config-panel/types";
import { deliveryPlanMutationViewSchema } from "@/lib/specs/delivery-plan-views";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import ManagedDeliveryWorkflowHeader from "./native-sdd/ManagedDeliveryWorkflowHeader";
import ManagedDeliveryLaunchControl from "./native-sdd/ManagedDeliveryLaunchControl";

interface ConnectedWorkflowBuilderPageProps {
  scope: WorkflowDefinitionScope;
  /** Deep-link target (`?definition=<id>`): pre-selects this definition. */
  initialWorkflowId?: string | null;
}

// A new builder draft starts charter-less from the user's point of view; the
// schema now requires one, so the empty draft carries a placeholder until the
// author fills it in. Charter authoring in the builder UI is owned by a later
// task.
const placeholderCharter: WorkflowCharter = {
  mission: "Describe this workflow's mission",
  // Authored-shape source: no retired accessPolicy, no prose appliesTo — the
  // authored write paths (validateAuthoredDefinition) refuse both, and an
  // unscoped source is global, which is the right default for a placeholder.
  sourcesOfTruth: [
    {
      rank: 1,
      id: "objective",
      label: "Workflow objective",
      type: "document",
      locator: "objective",
      description: "The stated objective for this workflow",
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
): CascadeWorkflowSemanticDefinition {
  return resolveWorkflowDefinition(
    { workflowDefaults: globalDefaults } as GlobalConfig,
    definition,
  );
}

export default function ConnectedWorkflowBuilderPage({
  scope,
  initialWorkflowId = null,
}: ConnectedWorkflowBuilderPageProps): React.JSX.Element {
  const isGlobal = scope.kind === "global";
  const queryClient = useQueryClient();
  const scopeApi = workflowDefinitionScopeApi(scope);
  const projectName = scope.kind === "project" ? scope.projectName : null;
  const { isMobile, mobilePanel, setMobilePanel, autoSwitchPanel } =
    useWorkflowMobilePanel<BuilderMobilePanel>("graph");
  const definitionsQuery = useScopedWorkflowDefinitionsQuery(scope);
  const { workflowDefaults } = useGlobalDefaults();
  const [requestedWorkflowId, setRequestedWorkflowId] = useState<string | null>(
    initialWorkflowId,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [pendingManagedAction, setPendingManagedAction] = useState<
    string | null
  >(null);
  const [configScope, setConfigScope] = useState<ConfigScope>("workflow");
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (s) => s.selectedContextId,
  );
  const draftDirty = _useGraphWorkflowBuilderStore((s) => s.dirty);
  // Output-schema text the draft could not absorb never reaches `dirty`, but it
  // is unsaved work all the same — the row that carries the draft has to say so
  // rather than showing it as clean.
  const outputSchemaBlocks = useOutputSchemaBlocks();
  const [prevSelectedContextId, setPrevSelectedContextId] = useState<
    string | null
  >(selectedContextId);

  if (selectedContextId !== prevSelectedContextId) {
    setPrevSelectedContextId(selectedContextId);
    if (selectedContextId) {
      setConfigScope("context");
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
  const managedSlug = selectedRecord.data?.item.management?.specSlug ?? "";
  const managedProjectName = projectName ?? "";
  const reopenPlan = useSpecActionMutation<{ reason: string }, unknown>(
    managedProjectName,
    managedSlug,
    "plan-reopen",
    deliveryPlanMutationViewSchema,
  );
  const abandonPlan = useSpecActionMutation<
    { reason: string },
    { attemptId: string }
  >(
    managedProjectName,
    managedSlug,
    "plan-abandon",
    z.object({ attemptId: z.string().min(1) }).strict(),
  );
  const signOffPlan = useSpecActionMutation<
    { expectedDraftRevision: number; expectedDefinitionRevision: number },
    unknown
  >(
    managedProjectName,
    managedSlug,
    "plan-sign-off",
    deliveryPlanMutationViewSchema,
  );
  const reaffirmPlan = useSpecActionMutation<
    { criterionElementIds: readonly string[]; expectedDraftRevision: number },
    unknown
  >(
    managedProjectName,
    managedSlug,
    "plan-reaffirm-batch",
    deliveryPlanMutationViewSchema,
  );
  const commentPlan = useSpecActionMutation<
    { contextId: string; body: string },
    unknown
  >(
    managedProjectName,
    managedSlug,
    "plan-comment",
    deliveryPlanMutationViewSchema,
  );

  const selectedSummary = useMemo(() => {
    return (
      definitionsQuery.data?.find((item) => item.id === selectedWorkflowId) ??
      null
    );
  }, [definitionsQuery.data, selectedWorkflowId]);

  // The list endpoint returns body-less summaries and this rework may not
  // change API responses, so every row's context count comes from its detail
  // record, read client-side through the same query key the loaded draft uses.
  const definitionIds = useMemo(
    () => (definitionsQuery.data ?? []).map((item) => item.id),
    [definitionsQuery.data],
  );
  const contextCounts = useScopedWorkflowDefinitionContextCounts(
    scope,
    definitionIds,
  );
  const sidebarDefinitions = useMemo(() => {
    return (definitionsQuery.data ?? []).map((item) => ({
      ...item,
      contextCount: contextCounts[item.id] ?? null,
    }));
  }, [definitionsQuery.data, contextCounts]);

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
  useAppHotkey("newWorkflow", () => void handleCreateWorkflow(), {
    enabled: !createMutation.isPending,
  });

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
        expectedRevision: item.revision,
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
        expectedRevision: item.revision,
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

  async function refreshManagedDefinition(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: scopeApi.listKey }),
      selectedWorkflowId
        ? queryClient.invalidateQueries({
            queryKey: scopeApi.detailKey(selectedWorkflowId),
          })
        : Promise.resolve(),
    ]);
  }

  async function runManagedAction(
    action: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    setPendingManagedAction(action);
    setManagedError(null);
    try {
      await run();
      await refreshManagedDefinition();
    } catch (error) {
      setManagedError(
        error instanceof Error ? error.message : "The plan action failed.",
      );
    } finally {
      setPendingManagedAction(null);
    }
  }

  function handleSignOff(): void {
    const item = selectedRecord.data?.item;
    const management = item?.management;
    if (!item || !management) return;
    // Sign-off approves the saved definition revision and leaves the approved
    // candidate read-only, so edits still on screen would be stranded.
    if (draftDirty || outputSchemaBlocks.length > 0) {
      setManagedError(
        "Save the draft before signing off; sign-off approves the saved revision.",
      );
      return;
    }
    void runManagedAction("sign-off", () =>
      signOffPlan.mutateAsync({
        expectedDraftRevision: management.bindingRevision,
        expectedDefinitionRevision: item.revision,
      }),
    );
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
                  isProject: true,
                },
                { label: "workflow-builder" },
              ]
        }
      />
      <WorkRailMain
        {...(projectName !== null ? { projectName } : {})}
        contentClassName="flex flex-col overflow-hidden max-768:pb-[calc(64px+env(safe-area-inset-bottom,0px))]"
      >
        <div className="relative flex h-full min-h-0 flex-1 max-768:flex-col">
          <WorkflowDefinitionsSidebar
            title={isGlobal ? "Global Templates" : "Definitions"}
            definitions={sidebarDefinitions}
            selectedId={selectedWorkflowId}
            onSelect={handleSelectDefinition}
            onCreate={() => void handleCreateWorkflow()}
            isLoading={definitionsQuery.isPending}
            isCreating={createMutation.isPending}
            activeDraftDirty={draftDirty || outputSchemaBlocks.length > 0}
            footer={
              <Link
                className="flex items-center gap-[6px] px-0 py-[6px] text-[0.72rem] font-medium text-text-secondary no-underline transition-colors duration-150 hover:text-text-primary max-768:min-h-[44px]"
                href={
                  projectName === null
                    ? "/projects"
                    : `/projects/${encodeURIComponent(projectName)}`
                }
              >
                <ChevronLeftIcon size={12} />
                {projectName === null ? "Back to Projects" : "Back to Sessions"}
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
                globalDefaults={workflowDefaults}
                configScope={configScope}
                onConfigScopeChange={setConfigScope}
                isMobile={isMobile}
                mobilePanel={mobilePanel}
                onAutoSwitchPanel={autoSwitchPanel}
                projectName={projectName}
                libraryProjectName={projectName}
                management={selectedRecord.data.item.management}
                readOnly={
                  selectedRecord.data.item.management !== undefined &&
                  !selectedRecord.data.item.management.editable
                }
                managedHeader={
                  selectedRecord.data.item.management ? (
                    <ManagedDeliveryWorkflowHeader
                      management={selectedRecord.data.item.management}
                      definitionRevision={selectedRecord.data.item.revision}
                      pendingAction={pendingManagedAction}
                      error={managedError}
                      onSignOff={handleSignOff}
                      onReopen={() =>
                        void runManagedAction("reopen", () =>
                          reopenPlan.mutateAsync({
                            reason:
                              "Reopened from Workflow Builder to revise the delivery candidate.",
                          }),
                        )
                      }
                      onAbandon={() =>
                        void runManagedAction("abandon", () =>
                          abandonPlan.mutateAsync({
                            reason: "Abandoned from Workflow Builder.",
                          }),
                        )
                      }
                      launchControl={
                        projectName ? (
                          <ManagedDeliveryLaunchControl
                            projectName={projectName}
                            management={selectedRecord.data.item.management}
                          />
                        ) : null
                      }
                    />
                  ) : null
                }
                onReaffirm={(criterionElementIds, expectedDraftRevision) =>
                  void runManagedAction("reaffirm", () =>
                    reaffirmPlan.mutateAsync({
                      criterionElementIds,
                      expectedDraftRevision,
                    }),
                  )
                }
                reaffirming={pendingManagedAction === "reaffirm"}
                managedError={managedError}
                onManagedComment={(input) =>
                  void runManagedAction("comment", () =>
                    commentPlan.mutateAsync(input),
                  )
                }
                commenting={pendingManagedAction === "comment"}
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
          label="Builder panels"
        />
      )}
    </div>
  );
}

const builderMobileTabs = [
  { value: "graph" as const, label: "Graph", icon: "graph" as const },
  { value: "definitions" as const, label: "Defs", icon: "list" as const },
  { value: "inspector" as const, label: "Inspector", icon: "panel" as const },
];
