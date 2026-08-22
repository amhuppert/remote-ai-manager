import { listSessionConversationListItems } from "./lib/state-store";
import { getStateDb } from "./lib/state-store/store";
import { getDb } from "./lib/state-store/state-db";
import { runMigrations } from "./lib/state-store/migrator";
import { runNativeSddV2CutoverBeforeStateDbOpen } from "./lib/state-store/migrations/0030-native-sdd-v2-cutover";
import { createContextArtifactsRepo } from "./lib/context-artifacts/repo";
import { initializeNotifications } from "./lib/notifications/service";
import { setConfigReader } from "./lib/push-notification/dispatcher";
import { readConfig, getConfigDirPath } from "./lib/config/loader";
import {
  ensureCapabilitySigningKey,
  ensureInstanceToken,
} from "./lib/agent-gateway/token";
import {
  installCctl,
  type InstallCctlResult,
} from "./lib/agent-gateway/install-cli";
import { publishManagedSkillBundleAtStartup } from "./lib/managed-skills/service";
import type { ManagedSkillBundle } from "./lib/managed-skills/schemas";
import {
  recordServerBaseUrl,
  verifyRecordedServerBaseUrl,
} from "./lib/agent-gateway/server-url";
import { getBuildInfo } from "./lib/build-info";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger, runAsTrace } from "./lib/logging";
import { recoverActiveWorkflowEnvelopes } from "./lib/workflows/primitives/recover-workflow-envelopes";
import { createAgentRunsRepo } from "./lib/agent-runs/repo";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "./lib/workflows/primitives/default-session-workflow-envelope-store";
import { createTicketsRepo } from "./lib/state-store/tickets-repo";
import { getSharedWriteQueue } from "./lib/state-store/write-queue";
import { recoverInterruptedConversationSnapshots as recoverInterruptedConversationSnapshotsForStartup } from "./lib/tickets/snapshot-refresh";
import { registerProductionSpecWorkflowComposition } from "./lib/specs/production-workflow-composition";
import { initializeValidationServiceAtStartup } from "./lib/validation/singleton";
import {
  collectOrphanedParkedRefs,
  type ParkedRefGcSummary,
} from "./lib/jobs/parked-ref-gc";
import { startEventLoopStallSentinel } from "./lib/logging/event-loop-stall-sentinel";
import { installRuntimeShutdownHook } from "./lib/agent-backends/runtime-shutdown";

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
  /** Publishes the CC managed skill bundle and records it for launch paths. */
  publishManagedSkills(): Promise<ManagedSkillBundle | null>;
  recordServerBaseUrl(): string;
  /** Marks orphaned pending compaction rows failed; returns the swept count. */
  sweepInterruptedCompactions(): number;
  /** Marks orphaned running agent-run rows failed; returns the swept count. */
  recoverStaleAgentRuns(): number;
  /**
   * Constructs the ValidationService singleton and runs its crash recovery:
   * admission stays closed until orphaned validation process groups are
   * terminated (nonce-verified) and their ledger rows marked interrupted.
   */
  initializeValidationService(): Promise<void>;
  /** Marks orphaned pending conversation snapshots failed. */
  recoverInterruptedConversationSnapshots(): Promise<number>;
  /**
   * Deletes `refs/cc-merges/` refs no job row still holds. Optional so a test
   * that is not about parked refs need not supply it.
   */
  collectOrphanedParkedRefs?(): Promise<ParkedRefGcSummary>;
  /**
   * Starts the event-loop stall sampler. Optional so a test that is not about
   * runtime instrumentation need not supply it.
   */
  startEventLoopStallSentinel?(): void;
  /**
   * Installs the signal hook that closes registered conversation runtimes on
   * shutdown. Optional so a test that is not about shutdown need not supply it.
   */
  installRuntimeShutdownHook?(): void;
  verifyServerBaseUrl(): void;
}

const defaultStartupDeps: StartupDeps = {
  loadConversationRehydration: () =>
    import("./lib/workflows/conversation/rehydration"),
  runStateMigrations: async () => {
    const configDir = getConfigDirPath();
    await runNativeSddV2CutoverBeforeStateDbOpen(configDir);
    return runMigrations({ db: getDb(), configDir });
  },
  registerSpecWorkflowComposition: registerProductionSpecWorkflowComposition,
  initNotificationDb: initializeNotifications,
  setConfigReader,
  readConfig,
  recoverActiveWorkflowEnvelopes,
  ensureAgentToken: async () => {
    const token = await ensureInstanceToken(getConfigDirPath());
    // Provisioned alongside the api token and never exported: it signs the
    // conversation and lane capabilities agent workflow authority is derived
    // from (D11, D4 R7). Separate from the token precisely because the token IS
    // exported, so a capability keyed on it would be agent-forgeable.
    await ensureCapabilitySigningKey(getConfigDirPath());
    return token;
  },
  installCli: () =>
    installCctl({
      bundlePath: path.join(process.cwd(), "dist", "cctl", "cctl.mjs"),
      configDir: getConfigDirPath(),
      // The identity this process pinned, so the binary it publishes is the one
      // it will keep answering for — the parity gate refuses anything else.
      expectedBuildInfo: getBuildInfo(),
    }),
  publishManagedSkills: publishManagedSkillBundleAtStartup,
  recordServerBaseUrl: () => recordServerBaseUrl(),
  sweepInterruptedCompactions: () =>
    createContextArtifactsRepo(getStateDb()).failPendingRuns(
      "interrupted by server restart",
      new Date().toISOString(),
    ),
  recoverStaleAgentRuns: () =>
    createAgentRunsRepo(getStateDb()).recoverStaleAgentRuns(),
  initializeValidationService: initializeValidationServiceAtStartup,
  recoverInterruptedConversationSnapshots: () =>
    recoverInterruptedConversationSnapshotsForStartup({
      repo: createTicketsRepo(getStateDb(), getSharedWriteQueue()),
      now: () => new Date().toISOString(),
    }),
  collectOrphanedParkedRefs: () => collectOrphanedParkedRefs(),
  startEventLoopStallSentinel,
  installRuntimeShutdownHook: () => {
    installRuntimeShutdownHook();
  },
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

    // Runs only past the fatal migration block: a startup that aborts must not
    // leave a sampling timer behind in the dying process.
    try {
      deps.startEventLoopStallSentinel?.();
    } catch (err) {
      logger.error("startup.event_loop_sentinel_failed", {
        error: getErrorMessage(err),
      });
    }

    // Same reasoning as the sentinel above: only a server that got past the
    // fatal migration block goes on to own runtimes worth closing.
    try {
      deps.installRuntimeShutdownHook?.();
    } catch (err) {
      logger.error("startup.runtime_shutdown_hook_failed", {
        error: getErrorMessage(err),
      });
    }

    deps.registerSpecWorkflowComposition?.();

    try {
      const recovered = await deps.recoverInterruptedConversationSnapshots();
      if (recovered > 0) {
        logger.info("startup.interrupted_conversation_snapshots_recovered", {
          count: recovered,
        });
      }
    } catch (err) {
      logger.error("startup.conversation_snapshot_recovery_failed", {
        error: getErrorMessage(err),
      });
    }

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

    // Validation crash recovery: detached validation process groups survive
    // an abrupt server death, and admitting a fresh full budget on top of
    // them would recreate the overload the scheduler exists to prevent. The
    // service keeps admission closed until recovery completes; a failure
    // here leaves validation refusing submissions rather than over-admitting.
    try {
      await runAsTrace(
        "startup:validation-recovery",
        deps.initializeValidationService,
      );
    } catch (err) {
      logger.error("startup.validation_recovery_failed", {
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

    // Publish the managed skill bundle (same server-owns-the-asset rule) so
    // Claude plugin attachment and the Codex skills bridge can resolve it at
    // launch. A failed publish means sessions run without managed skills —
    // never a failed startup.
    try {
      await deps.publishManagedSkills();
    } catch (err) {
      logger.error("startup.managed_skills_publish_failed", {
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
            listSessionConversationListItems,
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
            // A collaboration severed by a restart is FAILED, and operationally
            // so: the process died, not the work. Marking it failed is both
            // truthful and what makes it resumable — the resume path replays the
            // recorded artifacts and re-runs only what never completed.
            //
            // It used to be marked `paused` with a synthetic `recovery-<id>`
            // token instead. No client could supply that token, and the slice
            // had no replay, so the "recovery action" it advertised would have
            // re-run the whole collaboration from the first draft.
            resolveInactiveAction: ({ envelope }) => {
              if (envelope.workflowType === "collaboration") {
                return {
                  kind: "fail",
                  featureSnapshotPatch: {
                    failureCause: { kind: "process_restart" },
                    failureClass: "operational",
                  },
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

    // A prepared merge commit is reachable only through its `refs/cc-merges/`
    // ref, so a job that died before publishing or discarding leaves the commit
    // parked forever. Runs after the stale-job sweep above: that sweep decides
    // which `running` rows still belong to a live process, and a dead one's row
    // must not go on protecting a ref nothing will ever land.
    try {
      const collected = await deps.collectOrphanedParkedRefs?.();
      if (collected !== undefined && collected.deleted > 0) {
        logger.info("startup.orphaned_parked_refs_collected", {
          ...collected,
        });
      }
    } catch (err) {
      logger.error("startup.parked_ref_sweep_failed", {
        error: getErrorMessage(err),
      });
    }

    // Wire up push notification config reader
    deps.setConfigReader(deps.readConfig);
  };
}

export const register = createStartupRegistrar();
