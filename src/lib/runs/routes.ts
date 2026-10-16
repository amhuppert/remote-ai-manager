import { isEligibleSubscriptionRecipient } from "@/lib/conversations/provenance";
import { getSubscriptionRuntime } from "@/lib/subscriptions/service-factory";
import { readPromptDispatches } from "@/lib/conversation-core/prompt-evidence";
import { getTranscriptPath } from "@/lib/prompt/transcript";
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
import { deriveLaneTargets } from "@/lib/workspace/parallel-worktrees";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getArchivedProjects, getSession } from "@/lib/state-store";
import { getFinalizingSessionMergeJob } from "@/lib/jobs/queue";
import { getSessionLifecycleGate } from "@/lib/sessions/lifecycle-gate";
import {
  checkProfileResolves,
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  createConversation,
  deleteConversation,
} from "@/lib/conversations/service";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import { publishEvent } from "@/lib/events/publication";
import { createProductionRunTemplateService } from "@/lib/run-templates/production";
import { createSeatResolver, type SeatResolution } from "./seats";
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

/**
 * The launch seat resolver: each seat's profile checked against `library`,
 * the library a seat's spawn resolves through, then configured backend and
 * model admission.
 */
export function createRunSeatResolver(
  library: Pick<AgentProfileLibraryService, "resolve">,
): RunRouteDeps["resolveSeats"] {
  return createSeatResolver({
    admitSeat: resolveSeat,
    checkProfile: (projectPath, ref) =>
      checkProfileResolves(library, projectPath, ref),
  });
}

const resolveSeats = createRunSeatResolver(createAgentProfileLibraryService());

/**
 * A new owner as a person's launch creates it: the configured default
 * backend, admitted for an ordinary conversation, and the default profile.
 */
export function createNewOwnerPreparer(deps: {
  readConfig(): Promise<{ defaultAgentBackend: AgentBackendId }>;
  resolveProfileSnapshot(projectPath: string): Promise<AgentProfileSnapshot>;
}): RunRouteDeps["prepareNewOwner"] {
  return async (projectPath) => {
    const agentBackend = (await deps.readConfig()).defaultAgentBackend;
    try {
      await assertBackendExecution(agentBackend, {
        facet: "conversation",
        operation: "create-conversation",
        executionClass: "ordinary-conversation",
      });
    } catch (error) {
      if (!(error instanceof BackendAdmissionError)) throw error;
      return { ok: false, status: 400, error: error.message, code: error.code };
    }
    return {
      ok: true,
      owner: {
        agentBackend,
        profileSnapshot: await deps.resolveProfileSnapshot(projectPath),
      },
    };
  };
}

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
  sessionLifecycle: (projectPath, sessionName, operation) =>
    getSessionLifecycleGate().runExclusive(projectPath, sessionName, operation),
  finalizingMerge: getFinalizingSessionMergeJob,
  ownerAdmissible({ projectPath, sessionName, conversationId }) {
    const identity = getSubscriptionRuntime().readConversation(conversationId);
    return (
      identity !== null &&
      identity.sessionName === sessionName &&
      isEligibleSubscriptionRecipient(identity, projectPath)
    );
  },
  resolveSeats,
  newRunId,
  templates: createProductionRunTemplateService(),
  prepareNewOwner: createNewOwnerPreparer({
    readConfig,
    resolveProfileSnapshot: (projectPath) =>
      resolveConversationProfileSnapshot(projectPath, null),
  }),
  createOwner: ({ projectPath, sessionName, name, prepared }) =>
    createConversation(projectPath, sessionName, {
      name,
      agentBackend: prepared.agentBackend,
      profileSnapshot: prepared.profileSnapshot,
    }),
  removeOwner: deleteConversation,
  publish: publishEvent,
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
  auditEvidence: {
    async conversationFacts(projectPath, sessionName) {
      const session = await getSession(projectPath, sessionName);
      return new Map(
        (session?.conversations ?? []).map((conversation) => [
          conversation.id,
          {
            title: conversation.name ?? conversation.summary ?? null,
            backend: conversation.agentBackend,
            status: conversation.status,
            costUsd: conversation.totalCostUsd ?? null,
            turns: conversation.totalTurns ?? null,
          },
        ]),
      );
    },
    deliveriesForRun: (projectPath, runId) =>
      getSubscriptionRuntime().repo.listDeliveriesForRun(projectPath, runId),
    wakeBatchesForDeliveries: (ids) =>
      getSubscriptionRuntime().waitsRepo.listBatchesForDeliveries(ids),
    async promptDispatches(conversationId) {
      try {
        return await readPromptDispatches(
          await getTranscriptPath(conversationId),
        );
      } catch (error) {
        log.warn("runs.audit_transcript_unavailable", {
          conversationId,
          error: getErrorMessage(error),
        });
        return null;
      }
    },
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
export const launchTemplateRunPOST = withTracing(handlers.launchTemplate);
export const showRunGET = withTracing(handlers.show);
export const runAuditGET = withTracing(handlers.audit);
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
