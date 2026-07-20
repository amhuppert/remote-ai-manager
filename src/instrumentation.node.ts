import { readState } from "./lib/state-store";
import { getStateDb } from "./lib/state-store/store";
import { getDb } from "./lib/state-store/state-db";
import { runMigrations } from "./lib/state-store/migrator";
import { createContextArtifactsRepo } from "./lib/context-artifacts/repo";
import { initializeNotifications } from "./lib/notifications/service";
import { setConfigReader } from "./lib/push-notification/dispatcher";
import { readConfig, getConfigDirPath } from "./lib/config/loader";
import { ensureInstanceToken } from "./lib/agent-gateway/token";
import {
  installCctl,
  type InstallCctlResult,
} from "./lib/agent-gateway/install-cli";
import {
  recordServerBaseUrl,
  verifyRecordedServerBaseUrl,
} from "./lib/agent-gateway/server-url";
import { BUILD_INFO } from "./lib/build-info";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, runAsTrace } from "./lib/logging";
import { recoverActiveWorkflowEnvelopes } from "./lib/workflows/primitives/recover-workflow-envelopes";
import { createAgentRunsRepo } from "./lib/agent-runs/repo";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "./lib/workflows/primitives/default-session-workflow-envelope-store";
import { registerProductionSpecWorkflowComposition } from "./lib/specs/production-workflow-composition";

const logger = createLogger("startup");

export interface StartupDeps {
  loadConversationRehydration(): Promise<{
    rehydrateConversationActors(): Promise<number>;
  }>;
  runStateMigrations(): Promise<string[]>;
  registerSpecWorkflowComposition?(): void;
  initNotificationDb: typeof initializeNotifications;
  setConfigReader: typeof setConfigReader;
  readConfig: typeof readConfig;
  recoverActiveWorkflowEnvelopes: typeof recoverActiveWorkflowEnvelopes;
  ensureAgentToken(): Promise<string>;
  installCli(): Promise<InstallCctlResult>;
  recordServerBaseUrl(): string;
  /** Marks orphaned pending compaction rows failed; returns the swept count. */
  sweepInterruptedCompactions(): number;
  /** Marks orphaned running agent-run rows failed; returns the swept count. */
  recoverStaleAgentRuns(): number;
  verifyServerBaseUrl(): void;
}

const defaultStartupDeps: StartupDeps = {
  loadConversationRehydration: () =>
    import("./lib/workflows/conversation/rehydration"),
  runStateMigrations: () =>
    runMigrations({ db: getDb(), configDir: getConfigDirPath() }),
  registerSpecWorkflowComposition: registerProductionSpecWorkflowComposition,
  initNotificationDb: initializeNotifications,
  setConfigReader,
  readConfig,
  recoverActiveWorkflowEnvelopes,
  ensureAgentToken: () => ensureInstanceToken(getConfigDirPath()),
  installCli: () =>
    installCctl({
      bundlePath: path.join(process.cwd(), "dist", "cctl", "cctl.mjs"),
      configDir: getConfigDirPath(),
      expectedBuildInfo: BUILD_INFO,
    }),
  recordServerBaseUrl: () => recordServerBaseUrl(),
  sweepInterruptedCompactions: () =>
    createContextArtifactsRepo(getStateDb()).failPendingRuns(
      "interrupted by server restart",
      new Date().toISOString(),
    ),
  recoverStaleAgentRuns: () =>
    createAgentRunsRepo(getStateDb()).recoverStaleAgentRuns(),
  verifyServerBaseUrl: () => {
    void verifyRecordedServerBaseUrl();
  },
};

export function createStartupRegistrar(
  deps: StartupDeps = defaultStartupDeps,
): () => Promise<void> {
  return async () => {
    // Apply state-store migrations before any step reads or writes the DB. The
    // synchronous schema floor runs on DB open; this applies the async,
    // ledgered migrations (see state-store/migrator.ts). A failure is FATAL:
    // a partially-migrated database must never serve requests, run sweeps, or
    // rehydrate actors, so the error propagates and aborts server startup.
    // The failed migration stays out of the ledger, so the next startup
    // retries it (migrations are idempotent by contract).
    try {
      const applied = await runAsTrace(
        "startup:state-migrations",
        deps.runStateMigrations,
      );
      if (applied.length > 0) {
        logger.info("startup.state_migrations_applied", {
          migrations: applied,
        });
      }
    } catch (err) {
      logger.error("startup.state_migrations_failed", {
        error: getErrorMessage(err),
        fatal: true,
      });
      throw err;
    }

    deps.registerSpecWorkflowComposition?.();

    // A compaction run lives only in the compaction service's in-memory
    // single-flight map, so rows still `pending` now were interrupted by the
    // previous process shutting down. Sweep them to failed before any request
    // (or the lazily-created route-handler service) reads them, so the UI
    // offers Retry instead of an eternal "Compacting…".
    try {
      const swept = deps.sweepInterruptedCompactions();
      if (swept > 0) {
        logger.info("startup.interrupted_compactions_swept", { count: swept });
      }
    } catch (err) {
      logger.error("startup.compaction_sweep_failed", {
        error: getErrorMessage(err),
      });
    }

    // An agent run's abort handle lives only in this process's abort
    // registry, so rows still `running` now were orphaned by the previous
    // process shutting down — they would report running forever and cancel
    // would be a silent no-op. Sweep them to failed before any request reads
    // them.
    try {
      const sweptRuns = deps.recoverStaleAgentRuns();
      if (sweptRuns > 0) {
        logger.info("startup.stale_agent_runs_swept", { count: sweptRuns });
      }
    } catch (err) {
      logger.error("startup.agent_run_sweep_failed", {
        error: getErrorMessage(err),
      });
    }

    // The instance token gates all agent-facing endpoints and is injected into
    // spawned sessions' env, so it must exist before any conversation runs.
    try {
      await deps.ensureAgentToken();
    } catch (err) {
      logger.error("startup.agent_token_failed", {
        error: getErrorMessage(err),
      });
    }

    // The base URL feeds CC_SERVER_URL in every spawned session's env; record
    // it before conversations rehydrate so no session sees it unset. The
    // verification self-probe is fire-and-forget: register() completes before
    // the HTTP server listens, so awaiting it here would deadlock — its retry
    // loop absorbs the pre-listen window.
    try {
      deps.recordServerBaseUrl();
      deps.verifyServerBaseUrl();
    } catch (err) {
      logger.error("startup.server_url_failed", {
        error: getErrorMessage(err),
      });
    }

    // Publish this build's cctl bundle to <configDir>/bin. The server owns
    // the binary: sessions must run exactly the running server's version.
    try {
      await deps.installCli();
    } catch (err) {
      logger.error("startup.cli_install_failed", {
        error: getErrorMessage(err),
      });
    }

    // Rehydrate conversation actors from persisted machine snapshots
    try {
      const { rehydrateConversationActors } =
        await deps.loadConversationRehydration();
      const rehydrated = await runAsTrace(
        "startup:rehydrate-conversations",
        rehydrateConversationActors,
      );
      if (rehydrated > 0) {
        logger.info("startup.rehydrated_conversation_actors", {
          count: rehydrated,
        });
      }
    } catch (err) {
      logger.error("startup.conversation_rehydration_failed", {
        error: getErrorMessage(err),
      });
    }

    try {
      const envelopeSummary = await runAsTrace(
        "startup:recover-workflow-envelopes",
        () =>
          deps.recoverActiveWorkflowEnvelopes({
            readState,
            createRepository: ({ projectPath, sessionName }) =>
              createSessionWorkflowEnvelopeRepositoryForProduction({
                projectPath,
                sessionName,
              }),
            // Collaboration Mode runs in-process via `createCollaborationManager`,
            // which fires `runCollaborationSlice` from a route handler and does not
            // register the slice with any cross-process worker registry. A process
            // restart therefore severs the slice; recovery surfaces this by
            // marking previously-`running` envelopes `failed` with a restart
            // errorSummary. Paused envelopes are recoverable and preserved so the
            // UI can surface a resume affordance. Once an in-memory worker
            // registry exists, swap this predicate for a lookup against it.
            isWorkerActive: () => false,
            // Collaboration envelopes are recoverable: we mark them `paused` with
            // a synthetic resume token so the UI can surface a recovery action
            // that triggers `manager.resume` and replays the slice from the last
            // completed round. Other workflow types fall through to the default
            // `markFailed` behavior.
            resolveInactiveAction: ({ envelope }) => {
              if (envelope.workflowType === "collaboration") {
                return {
                  kind: "preserve_paused",
                  pauseGateKind: "human_approval",
                  resumeToken: `recovery-${envelope.workflowId}`,
                };
              }
              return { kind: "fail" };
            },
          }),
      );
      if (
        envelopeSummary.failed > 0 ||
        envelopeSummary.preservedPaused > 0 ||
        envelopeSummary.preservedRunning > 0 ||
        envelopeSummary.movedToPaused > 0
      ) {
        logger.info("startup.recovered_workflow_envelopes", {
          ...envelopeSummary,
        });
      }
    } catch (err) {
      logger.error("startup.workflow_envelope_recovery_failed", {
        error: getErrorMessage(err),
      });
    }

    try {
      deps.initNotificationDb();
      logger.info("startup.notification_db_initialized");
    } catch (err) {
      logger.error("startup.notification_db_failed", {
        error: getErrorMessage(err),
      });
    }

    // Wire up push notification config reader
    deps.setConfigReader(deps.readConfig);
  };
}

export const register = createStartupRegistrar();
