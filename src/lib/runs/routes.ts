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
import { getSession } from "@/lib/state-store";
import type { ResolvedSeat } from "./launch";
import { getSupervision } from "@/lib/supervision/production";
import {
  createRunRouteHandlers,
  newRunId,
  type RunRouteDeps,
} from "./route-handlers";

const log = createLogger("runs");

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
    const targets = deriveLaneTargets({ projectPath, sessionDir, laneId, branchPrefix });
    return { worktreePath: targets.worktreePath, branch: targets.branchName };
  };
};

const handlers = createRunRouteHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  laneTargets,
  supervision: getSupervision,
  resolveSeats,
  newRunId,
  log,
});

export const launchRunPOST = withTracing(handlers.launch);
export const launchWorkflowRunPOST = withTracing(handlers.launchWorkflow);
export const showRunGET = withTracing(handlers.show);
export const runDefinitionGET = withTracing(handlers.definition);
export const answerRunPOST = withTracing(handlers.answer);
export const controlRunPOST = withTracing(handlers.control);
export const amendRunPOST = withTracing(handlers.amend);
export const decideRunPOST = withTracing(handlers.decide);
export const contextTasksPOST = withTracing(handlers.tasks);
