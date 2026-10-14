import { publishEvent } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { readConfig } from "@/lib/config/loader";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { supervisedSeatWorkplace } from "@/lib/supervision/handles";
import type { SupervisedSeatWorkplace } from "@/lib/supervision/supervision";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import {
  getConversation,
  getProjectConversation,
  getSession,
} from "@/lib/state-store";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { getStateDb } from "@/lib/state-store/store";
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

export interface ProductionValidationResolverDeps {
  /** The run seat this conversation is bound to, or null for any other conversation. */
  seatWorkplace(
    conversationId: string,
  ): Promise<SupervisedSeatWorkplace | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readRepoValidation(projectPath: string): Promise<RepoValidationConfig | null>;
}

const productionResolverDeps: ProductionValidationResolverDeps = {
  seatWorkplace: async (conversationId) =>
    supervisedSeatWorkplace(conversationId),
  getSession: (projectPath, sessionName) =>
    getSession(projectPath, sessionName),
  readRepoValidation: async (projectPath) =>
    (await readRepoConfig(projectPath))?.validation ?? null,
};

export function createProductionValidationCallerResolver(
  deps: ProductionValidationResolverDeps = productionResolverDeps,
): {
  resolveCaller(ref: ValidationCallerRef): Promise<ResolvedValidationCaller>;
} {
  /**
   * A run seat validates where it works, with the commands frozen for it; a
   * seat that cannot be placed is refused, never sent to the session worktree.
   */
  async function resolveRunSeat(
    ref: ValidationCallerRef,
    seat: SupervisedSeatWorkplace,
  ): Promise<ResolvedValidationCaller> {
    if (
      seat.projectPath !== ref.projectPath ||
      seat.sessionName !== (ref.sessionName ?? null)
    )
      return ambiguous(
        `run seat of context "${seat.contextId}" belongs to session "${seat.sessionName}"`,
      );
    const { workplace } = seat;
    if (workplace.kind === "refused") return ambiguous(workplace.reason);
    const session = await deps.getSession(seat.projectPath, seat.sessionName);
    if (!session)
      return ambiguous(`session "${seat.sessionName}" was not found`);
    return {
      kind: "run_seat",
      worktreePath: workplace.worktreePath,
      sessionName: seat.sessionName,
      // A lane's diff base is the session branch it publishes into.
      branchName: workplace.branch ?? session.branchName,
      targetBranch:
        workplace.branch === null ? session.targetBranch : session.branchName,
      contextId: seat.contextId,
      role: workplace.role,
      allowedCommands: workplace.validationAccess,
    };
  }

  return {
    async resolveCaller(ref) {
      if (ref.conversationId) {
        const seat = await deps.seatWorkplace(ref.conversationId);
        if (seat !== null) return resolveRunSeat(ref, seat);
      }
      const sessionName = ref.sessionName ?? null;
      if (!sessionName) {
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

      return {
        kind: "session",
        worktreePath: session.worktreePath,
        sessionName,
        branchName: session.branchName,
        targetBranch: session.targetBranch,
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
      getConversationName: async (projectPath, sessionName, conversationId) => {
        const conversation = sessionName
          ? await getConversation(projectPath, sessionName, conversationId)
          : await getProjectConversation(projectPath, conversationId);
        return conversation?.name ?? null;
      },
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
