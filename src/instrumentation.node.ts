import { readState } from "./lib/state-store";
import { getDb } from "./lib/state-store/state-db";
import { runMigrations } from "./lib/state-store/migrator";
import { initialize as initNotificationDb } from "./lib/notifications/repo";
import { setConfigReader } from "./lib/push-notification/dispatcher";
import { readConfig, getConfigDirPath } from "./lib/config/loader";
import { ensureInstanceToken } from "./lib/agent-gateway/token";
import {
  installCctl,
  type InstallCctlResult,
} from "./lib/agent-gateway/install-cli";
import { recordServerBaseUrl } from "./lib/agent-gateway/server-url";
import { BUILD_INFO } from "./lib/build-info";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, runAsTrace } from "./lib/logging";
import { recoverActiveWorkflowEnvelopes } from "./lib/workflows/primitives/recover-workflow-envelopes";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "./lib/workflows/primitives/default-session-workflow-envelope-store";

const logger = createLogger("startup");

export interface StartupDeps {
  loadConversationManager(): Promise<{
    rehydrateConversationActors(): Promise<number>;
  }>;
  runStateMigrations(): Promise<string[]>;
  initNotificationDb: typeof initNotificationDb;
  setConfigReader: typeof setConfigReader;
  readConfig: typeof readConfig;
  recoverActiveWorkflowEnvelopes: typeof recoverActiveWorkflowEnvelopes;
  ensureAgentToken(): Promise<string>;
  installCli(): Promise<InstallCctlResult>;
  recordServerBaseUrl(): string;
}

const defaultStartupDeps: StartupDeps = {
  loadConversationManager: () => import("./lib/workflows/conversation/manager"),
  runStateMigrations: () =>
    runMigrations({ db: getDb(), configDir: getConfigDirPath() }),
  initNotificationDb,
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
};

export function createStartupRegistrar(
  deps: StartupDeps = defaultStartupDeps,
): () => Promise<void> {
  return async () => {
    // Apply state-store migrations before any step reads or writes the DB. The
    // synchronous schema floor runs on DB open; this applies the async,
    // ledgered migrations (see state-store/migrator.ts).
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
    // it before conversations rehydrate so no session sees it unset.
    try {
      deps.recordServerBaseUrl();
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
        await deps.loadConversationManager();
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
