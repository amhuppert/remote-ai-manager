import {
  listBackendCatalogEntries,
  getConfiguredBackendModelCatalog,
} from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import { specControlsDetailFixture } from "@/features/spec-studio/SpecControls.fixtures";
import {
  createWorkflowExecution,
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowLayout,
  makeValidatorCohort,
  makeSeededValidatorCohort,
} from "@/lib/workflow-graph/test-fixtures";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import type { CheckpointTarget } from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointForkRequest } from "@/lib/conversation-checkpoints/fork-schemas";

export type ForkStoryState =
  | "ready"
  | "pending"
  | "failed"
  | "references_loading"
  | "no_references";
export function checkpointForkStoryFetch(
  target: CheckpointTarget,
  state: ForkStoryState = "ready",
): typeof fetch {
  const detail = specControlsDetailFixture();
  const working = createResolvedWorkflowDefinition();
  working.executionContexts[0]!.contextValidator = makeSeededValidatorCohort();
  const execution = createWorkflowExecution({
    workingDefinition: working,
    launchDocument: {
      name: "Checkpoint delivery",
      description: null,
      definition: createWorkflowDefinition({
        workflowConfig: { contextValidator: makeValidatorCohort() },
      }),
      layout: createWorkflowLayout(),
    },
  });
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/voice/health")
      return response({ available: false });
    if (url.pathname === "/api/agent-backends")
      return response({
        backends: listBackendCatalogEntries().map((entry) => ({
          ...entry,
          capabilities: entry.capabilities && {
            ...entry.capabilities,
            checkpointFork: entry.id !== "cursor",
          },
        })),
      });
    if (url.pathname.endsWith("/model-options"))
      return response({
        backends: listBackendCatalogEntries().map(({ id: backend }) => {
          const catalog = getConfiguredBackendModelCatalog(backend);
          return {
            backend,
            models: [],
            defaultModelId: catalog.defaultModelId,
            source: "catalog",
            modelCatalog: catalog,
            defaultSelection: defaultSelectionForModel(
              catalog,
              catalog.defaultModelId,
            ),
            diagnostics: [],
          };
        }),
      });
    if (url.pathname.endsWith("/tickets")) {
      if (state === "references_loading")
        return new Promise<Response>(() => {});
      return response(
        state === "no_references"
          ? []
          : [
              {
                id: "ticket-131",
                projectPath: "/repos/command-center",
                projectName: target.projectName,
                number: 131,
                title: "Fork the next phase from a checkpoint",
                workType: "feature",
                status: "in_progress",
                attachmentCount: 0,
                activeSessionName: null,
                createdAt: "2026-09-12T12:00:00Z",
                updatedAt: "2026-09-12T12:00:00Z",
              },
            ],
      );
    }
    if (url.pathname === `/api/specs/${target.projectName}`)
      return response({
        specs: [
          {
            spec: detail.spec,
            phase: detail.status.phase,
            currentRevision: detail.currentRevision!.revision,
            counts: { requirements: 1, criteria: 1, decisions: 0, tasks: 1 },
            pendingApprovalCount: 0,
            approvalState: "complete",
            delivery: detail.status.delivery,
            linkedWork: {
              tickets: 0,
              conversations: 0,
              sessions: 0,
              workflowExecutions: 0,
              mergeJobs: 0,
            },
            imported: false,
          },
        ],
      });
    if (url.pathname.startsWith(`/api/specs/${target.projectName}/`))
      return response({
        spec: detail.spec,
        currentRevision: detail.currentRevision,
        questions: [],
        assumptions: [],
      });
    if (url.pathname === "/api/live-references/executions")
      return response({
        items: [
          {
            projectName: target.projectName,
            sessionName: "implement-auth",
            executionId: execution.id,
            title: "Checkpoint delivery",
            status: execution.status,
            startedAt: execution.startedAt,
          },
        ],
      });
    if (url.pathname.includes("/graph-workflow/executions/"))
      return response({ execution });
    if (url.pathname.endsWith("/fork") && init?.method === "POST") {
      if (state === "pending") return new Promise<Response>(() => {});
      if (state === "failed")
        return response(
          {
            error:
              "The selected checkpoint is unavailable. Choose a saved checkpoint and try again.",
            code: "checkpoint_not_found",
          },
          404,
        );
      const body = JSON.parse(String(init?.body)) as CheckpointForkRequest;
      const origin = checkpointForkOriginFixture({
        source: target,
        evidenceSource: target,
        relatedWork: body.relatedWork,
        initialSelection: {
          backend: body.backend,
          modelSelection: body.modelSelection,
        },
        operationId: body.requestId,
      });
      return response({
        conversation: toPublicConversationState(
          makeConversationState({
            id: body.requestId,
            scope: target.scope,
            name: body.name,
            agentBackend: body.backend,
            pendingPromptText: body.task,
            checkpointFork: origin,
          }),
        ),
        receipt: {
          ...checkpointReceiptFixture({
            operationId: body.requestId,
            scope: target.scope,
            conversationId: body.requestId,
          }),
          forkOrigin: origin,
        },
        reused: false,
      });
    }
    throw new Error(
      `Unfixtured checkpoint fork story request: ${url.pathname}`,
    );
  };
}
