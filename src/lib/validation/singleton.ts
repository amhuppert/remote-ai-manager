import { publishEvent } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getActiveGraphWorkflowExecution, getSession } from "@/lib/state-store";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { getStateDb } from "@/lib/state-store/store";
import {
  DEFAULT_AGENT_VALIDATION_CONFIG,
  type GraphWorkflowCommandSelector,
} from "@/lib/workflow-graph/config-schemas";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { expandCommandSelector } from "@/lib/workflow-graph/resolve-config";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { spawnValidation } from "./process-runner";
import {
  globalValidationConfigSchema,
  type RepoValidationConfig,
} from "./schemas";
import { createProcessGroupIdentity } from "./recovery";
import { createValidationScheduler } from "./scheduler";
import {
  createValidationService,
  type ResolvedValidationCaller,
  type ValidationCallerRef,
  type ValidationService,
} from "./service";

const logger = createLogger("validation");

/**
 * Production composition of the ValidationService: the process-wide
 * singleton every consumer (CLI route, graph script gate, lane merge, Smart
 * Merge/Commit) must share, because the global cost budget is only exact
 * when one scheduler sees every run. Constructed lazily, initialized at
 * server startup with crash recovery (admission stays closed until the
 * ledger is reconciled), a periodic lease-expiry sweep, and SIGTERM/SIGINT
 * hooks that run graceful shutdown before the process exits. All mutable
 * composition state lives on globalThis so a Next.js HMR module re-evaluation
 * can never construct a second service (or second sweep) over the same
 * ledger and process groups.
 */

const LEASE_SWEEP_INTERVAL_MS = 15_000;

function ambiguous(reason: string): ResolvedValidationCaller {
  return { kind: "ambiguous", reason };
}

type ConversationLaneLookup =
  | { kind: "none" }
  | { kind: "unique"; lane: GraphWorkflowAgentSessionState }
  | { kind: "ambiguous" };

function findLaneForConversation(
  execution: GraphWorkflowExecution,
  conversationId: string,
): ConversationLaneLookup {
  const matches: GraphWorkflowAgentSessionState[] = [];
  for (const perContext of Object.values(execution.laneStates)) {
    for (const lane of Object.values(perContext)) {
      if (lane.workflowConversationId === conversationId) matches.push(lane);
    }
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "unique", lane: matches[0]! };
}

/**
 * Expand a selector for executions persisted before explicit command
 * snapshots were introduced. Current executions authorize from the snapshot
 * itself so registry edits cannot broaden their running lanes.
 */
function expandLanePolicy(
  selector: GraphWorkflowCommandSelector,
  registryNames: readonly string[],
): readonly string[] {
  return expandCommandSelector(selector, [...registryNames]).commands;
}

export interface ProductionValidationResolverDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  readRepoValidation(projectPath: string): Promise<RepoValidationConfig | null>;
}

const productionResolverDeps: ProductionValidationResolverDeps = {
  getSession: (projectPath, sessionName) =>
    getSession(projectPath, sessionName),
  getActiveGraphWorkflowExecution: (projectPath, sessionName) =>
    getActiveGraphWorkflowExecution(projectPath, sessionName),
  readRepoValidation: async (projectPath) =>
    (await readRepoConfig(projectPath))?.validation ?? null,
};

export function createProductionValidationCallerResolver(
  deps: ProductionValidationResolverDeps = productionResolverDeps,
): {
  resolveCaller(ref: ValidationCallerRef): Promise<ResolvedValidationCaller>;
} {
  const targetResolver = createExecutionTargetResolver();
  return {
    async resolveCaller(ref) {
      const sessionName = ref.sessionName ?? null;
      if (!sessionName) {
        if (ref.claimedWorkflow) {
          return ambiguous(
            "workflow identity was claimed outside any session scope",
          );
        }
        // Project conversation: validate the repo root itself.
        return {
          kind: "project",
          worktreePath: ref.projectPath,
          sessionName: null,
          branchName: null,
          targetBranch: null,
        };
      }

      const session = await deps.getSession(ref.projectPath, sessionName);
      if (!session) {
        return ambiguous(`session "${sessionName}" was not found`);
      }

      const conversationId = ref.conversationId ?? null;
      const execution = await deps.getActiveGraphWorkflowExecution(
        ref.projectPath,
        sessionName,
      );
      if (!execution) {
        if (ref.claimedWorkflow) {
          return ambiguous(
            "claimed workflow identity does not match an active execution",
          );
        }
        return {
          kind: "session",
          worktreePath: session.worktreePath,
          sessionName,
          branchName: session.branchName,
          targetBranch: session.targetBranch,
        };
      }

      if (!conversationId) {
        return ambiguous(
          "an active execution requires a conversation id for lane policy resolution",
        );
      }
      const lookup = findLaneForConversation(execution, conversationId);
      if (lookup.kind === "ambiguous") {
        return ambiguous(
          `conversation "${conversationId}" maps to multiple execution lanes`,
        );
      }
      if (lookup.kind === "none") {
        return ambiguous(
          `conversation "${conversationId}" does not map to a lane in the active execution`,
        );
      }
      const lane = lookup.lane;

      // Claimed graph identity must match server-side state exactly;
      // anything missing, stale, or mismatched fails closed.
      if (ref.claimedWorkflow) {
        if (
          ref.claimedWorkflow.executionId !== execution.id ||
          ref.claimedWorkflow.contextId !== lane.contextId ||
          (ref.claimedWorkflow.role !== undefined &&
            ref.claimedWorkflow.role !== lane.lane)
        ) {
          return ambiguous(
            "claimed workflow identity is stale or mismatched against execution state",
          );
        }
      }

      const context = execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === lane.contextId,
      );
      if (!context) {
        return ambiguous(
          `lane context "${lane.contextId}" is not present in the execution definition`,
        );
      }

      // The context state's lane assignment is the authoritative source for
      // where this lane executes (an execution lane's includedContextIds
      // fills in only as contexts COMMIT, so an actively running lane may
      // list none). The canonical resolver reads it and throws on
      // inconsistent state — worktree targeting fails closed rather than
      // silently validating the session worktree.
      let worktreePath: string;
      let branchName: string;
      let targetBranch: string;
      try {
        const target = targetResolver.resolve({
          execution,
          contextId: lane.contextId,
          session,
        });
        worktreePath = target.worktreePath;
        branchName = target.branchName;
        // The diff base is whatever the lane's branch merges into: a lane
        // worktree targets the session branch, while a session-isolated
        // context IS the session branch — pointing TARGET_BRANCH at itself
        // would give merge-base-scoped validation an empty diff.
        targetBranch =
          target.isolation === "worktree"
            ? session.branchName
            : session.targetBranch;
      } catch (err) {
        return ambiguous(
          `execution target for lane context "${lane.contextId}" did not resolve: ${getErrorMessage(err)}`,
        );
      }

      const repoValidation = await deps.readRepoValidation(ref.projectPath);
      const registryNames = Object.keys(repoValidation?.commands ?? {});
      const snapshot = context.agentValidation;
      const rolePolicy =
        lane.lane === "implementer"
          ? snapshot?.implementer
          : snapshot?.contextValidator;
      const selector =
        rolePolicy?.value ??
        (lane.lane === "implementer"
          ? DEFAULT_AGENT_VALIDATION_CONFIG.implementer
          : DEFAULT_AGENT_VALIDATION_CONFIG.contextValidator);
      const scriptGateCommands = context.scriptValidator.commands ?? [];

      return {
        kind: "graph_lane",
        worktreePath,
        sessionName,
        branchName,
        targetBranch,
        executionId: execution.id,
        contextId: lane.contextId,
        role: lane.lane,
        allowedCommands:
          rolePolicy?.commands ?? expandLanePolicy(selector, registryNames),
        scriptGateCommands,
      };
    },
  };
}

interface ValidationSingletonHost {
  instance: ValidationService | null;
  sweepTimer: NodeJS.Timeout | null;
  shutdownHooksInstalled: boolean;
}

function hostState(): ValidationSingletonHost {
  return getGlobalSingleton<ValidationSingletonHost>(
    "__cc_validation_service_host",
    () => ({ instance: null, sweepTimer: null, shutdownHooksInstalled: false }),
  );
}

export function getValidationService(): ValidationService {
  const host = hostState();
  if (!host.instance) {
    const db = getStateDb();
    const repo = createValidationRunsRepo(db);
    // Admission decisions are short synchronous better-sqlite3 transactions
    // on the shared connection; nothing yields mid-transaction, so they
    // cannot interleave with the async write queue's own transactions.
    const transact = <T>(_label: string, fn: () => T): T =>
      db.transaction(fn)();
    host.instance = createValidationService({
      repo,
      transact,
      scheduler: createValidationScheduler({ repo, transact }),
      runner: { spawn: (params) => spawnValidation(params) },
      resolver: createProductionValidationCallerResolver(),
      config: {
        readRepoValidation: async (projectPath) =>
          (await readRepoConfig(projectPath))?.validation ?? null,
        readGlobal: async () =>
          (await readConfig()).validation ??
          globalValidationConfigSchema.parse({}),
      },
      identity: createProcessGroupIdentity(),
      publish: publishEvent,
    });
  }
  return host.instance;
}

/**
 * The subset of `process` the shutdown hooks touch, injectable for tests.
 * `process` itself satisfies it.
 */
export interface ValidationShutdownProcessHost {
  pid: number;
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}

/**
 * Hook graceful shutdown into process termination: on SIGTERM/SIGINT the
 * service group-kills tracked validation runs (releasing each reservation
 * only after confirmed group death) before the signal is re-raised to let
 * termination proceed. Installed once per process — the globalThis flag makes
 * module re-evaluation a no-op. Returns whether this call installed them.
 */
export function installValidationShutdownHooks(
  service: ValidationService,
  proc: ValidationShutdownProcessHost = process,
): boolean {
  const host = hostState();
  if (host.shutdownHooksInstalled) return false;
  host.shutdownHooksInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    proc.once(signal, () => {
      logger.info("validation.shutdown_signal", { signal });
      void service
        .shutdown()
        .catch((err: unknown) => {
          logger.error("validation.shutdown_failed", {
            error: getErrorMessage(err),
          });
        })
        .finally(() => {
          // This once-listener is consumed, so re-raising resumes default
          // termination (or the platform's remaining handlers).
          proc.kill(proc.pid, signal);
        });
    });
  }
  return true;
}

/**
 * Startup hook (owned by this composition site): construct the singleton,
 * run crash recovery to completion before any consumer submits, and — only
 * when recovery succeeded — start the lease-expiry sweep and install the
 * graceful-shutdown signal hooks. After a FAILED recovery the service is
 * refusing every submission and its retained non-terminal rows belong to
 * process groups this process could not verify; a sweep or shutdown pass
 * over them would terminalize rows without group death and let the next
 * restart reopen admission over live work.
 */
export async function initializeValidationServiceAtStartup(
  overrides: {
    service?: ValidationService;
    proc?: ValidationShutdownProcessHost;
  } = {},
): Promise<void> {
  const service = overrides.service ?? getValidationService();
  await service.whenReady();
  if (!service.isAvailable()) {
    logger.error("validation.startup_degraded", {
      reason:
        "recovery failed; admission stays closed and no sweep or shutdown hooks were started",
    });
    return;
  }
  const host = hostState();
  if (!host.sweepTimer) {
    host.sweepTimer = setInterval(() => {
      service.sweepExpiredLeases().catch((err: unknown) => {
        logger.warn("validation.lease_sweep_failed", {
          error: getErrorMessage(err),
        });
      });
    }, LEASE_SWEEP_INTERVAL_MS);
    host.sweepTimer.unref();
  }
  installValidationShutdownHooks(service, overrides.proc ?? process);
}

/** Test-only: the globalThis-hosted composition state, for identity checks. */
export function _validationSingletonHostForTesting(): object {
  return hostState();
}

/** Test-only: drop the singleton, its sweep timer, and the hook flag. */
export function _resetValidationServiceForTesting(): void {
  const host = hostState();
  if (host.sweepTimer) clearInterval(host.sweepTimer);
  host.sweepTimer = null;
  host.instance = null;
  host.shutdownHooksInstalled = false;
}
