import { isEligibleSubscriptionRecipient } from "@/lib/conversations/provenance";
import { getSubscriptionRuntime } from "@/lib/subscriptions/service-factory";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import { resolveAgentBackendTurnDefaults } from "@/lib/agent-backends/conversation-policy";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import path from "node:path";
import { resolveBranchPrefix } from "@/lib/config/cascade";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { deriveLaneTargets } from "@/lib/workflow-graph/parallel-worktrees";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getArchivedProjects, getSession } from "@/lib/state-store";
import type { ResolvedSeat } from "./launch";
import { snapshotDocumentFile, snapshotRunDocuments } from "./documents";
import { freezeCharter } from "./charter";
import { getArtifactStore } from "@/lib/artifacts/production";
import { getSupervision } from "@/lib/supervision/production";
import { createWorkspaceEvidence } from "@/lib/workspace/evidence";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  createRunRouteHandlers,
  newRunId,
  type RunRouteDeps,
} from "./route-handlers";

const log = createLogger("runs");
const workspaceEvidence = createWorkspaceEvidence();

type SeatResolution =
  | { ok: true; seat: ResolvedSeat }
  | { ok: false; status: number; error: string; code?: string };

/** Configured defaults and admission for one seat: what a launch omits, configuration supplies. */
async function resolveSeat(
  projectPath: string,
  backend: AgentBackendId | undefined,
  explicit: BackendModelSelection | undefined,
): Promise<SeatResolution> {
  const config = await readConfig();
  const resolvedBackend = backend ?? config.defaultAgentBackend;
  try {
    await assertBackendExecution(resolvedBackend, {
      facet: "conversation",
      operation: "run-seat",
      executionClass: "governed-execution",
    });
  } catch (error) {
    if (!(error instanceof BackendAdmissionError)) throw error;
    return { ok: false, status: 400, error: error.message, code: error.code };
  }
  const defaults = resolveAgentBackendTurnDefaults({
    backend: resolvedBackend,
    config,
    ...(explicit !== undefined
      ? { explicit: { modelSelection: explicit } }
      : {}),
  });
  const admission = await admitConfiguredModelSelection({
    backend: resolvedBackend,
    projectPath,
    modelSelection: defaults.modelSelection,
    config,
  });
  if (!admission.ok)
    return {
      ok: false,
      status: 400,
      error: admission.message,
      code: admission.code,
    };
  return {
    ok: true,
    seat: {
      backend: resolvedBackend,
      modelSelection: admission.modelSelection,
    },
  };
}

const resolveSeats: RunRouteDeps["resolveSeats"] = async ({
  projectPath,
  request,
}) => {
  const implementer = await resolveSeat(
    projectPath,
    request.backend,
    request.modelSelection,
  );
  if (!implementer.ok) return implementer;
  const reviewers: ResolvedSeat[] = [];
  for (const reviewer of request.reviewers ?? []) {
    const resolved = await resolveSeat(
      projectPath,
      reviewer.backend,
      reviewer.modelSelection,
    );
    if (!resolved.ok) return resolved;
    reviewers.push(resolved.seat);
  }
  return { ok: true, seats: { implementer: implementer.seat, reviewers } };
};

/** Lane worktrees sit beside the session's, named as every CC lane is; the branch prefix is read once, at launch. */
const laneTargets: RunRouteDeps["laneTargets"] = async ({
  projectPath,
  sessionWorktreePath,
}) => {
  const [config, repoConfig] = await Promise.all([
    readConfig(),
    readRepoConfig(projectPath),
  ]);
  const branchPrefix = resolveBranchPrefix(config, repoConfig);
  const sessionDir = path.basename(sessionWorktreePath);
  return (laneId) => {
    const targets = deriveLaneTargets({
      projectPath,
      sessionDir,
      laneId,
      branchPrefix,
    });
    return { worktreePath: targets.worktreePath, branch: targets.branchName };
  };
};

const handlers = createRunRouteHandlers({
  auth: createAgentAuth(),
  archivedProjects: getArchivedProjects,
  resolveProjectPath,
  getSession,
  laneTargets,
  async validationCommands(projectPath) {
    const repoConfig = await readRepoConfig(projectPath);
    return Object.keys(repoConfig?.validation?.commands ?? {});
  },
  supervision: getSupervision,
  async ownerWakeable(projectPath, conversationId) {
    const runtime = getSubscriptionRuntime();
    return isEligibleSubscriptionRecipient(
      runtime.readConversation(conversationId),
      projectPath,
    );
  },
  resolveSeats,
  newRunId,
  snapshotDocuments: (requests, worktreePath, current) =>
    snapshotRunDocuments({
      requests,
      worktreePath,
      ...(current !== undefined ? { current } : {}),
      store: getArtifactStore(),
    }),
  snapshotFile: (worktreePath, file) =>
    snapshotDocumentFile({ worktreePath, file, store: getArtifactStore() }),
  freezeCharter: (charter) =>
    freezeCharter({ charter, store: getArtifactStore() }),
  async sessionConversations(projectPath, sessionName) {
    const session = await getSession(projectPath, sessionName);
    return new Map(
      (session?.conversations ?? []).map((conversation) => [
        conversation.id,
        {
          title: conversation.name ?? conversation.summary,
          backend: conversation.agentBackend,
          working: conversation.status === "running",
          costUsd: conversation.totalCostUsd ?? 0,
          turns: conversation.totalTurns ?? 0,
        },
      ]),
    );
  },
  async readText(artifactId) {
    return (await getArtifactStore().read(artifactId)).toString("utf8");
  },
  async candidateChanges({ worktreePath, scope, evidence }) {
    try {
      return {
        ok: true,
        diff: await workspaceEvidence.changes(worktreePath, scope, evidence),
      };
    } catch (error) {
      // A candidate's tree can be pruned or its worktree gone; the page shows the rest.
      log.warn("runs.candidate_changes_unavailable", {
        worktreePath,
        error: getErrorMessage(error),
      });
      return { ok: false, reason: getErrorMessage(error) };
    }
  },
  log,
});

export const launchRunPOST = withTracing(handlers.launch);
export const launchWorkflowRunPOST = withTracing(handlers.launchWorkflow);
export const showRunGET = withTracing(handlers.show);
export const listRunsGET = withTracing(handlers.list);
export const activeRunsGET = withTracing(handlers.active);
export const runPageGET = withTracing(handlers.page);
export const runDefinitionGET = withTracing(handlers.definition);
export const answerRunPOST = withTracing(handlers.answer);
export const controlRunPOST = withTracing(handlers.control);
export const amendRunPOST = withTracing(handlers.amend);
export const decideRunPOST = withTracing(handlers.decide);
export const contextTasksPOST = withTracing(handlers.tasks);
export const contextDocumentsPOST = withTracing(handlers.publishDocument);
