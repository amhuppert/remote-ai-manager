import { createLogger } from "@/lib/logging";
import { getMemoryService, getMemoryTelemetryService } from "./service-factory";
import type { MemoryService } from "./service";
import type { MemoryTelemetryService } from "./telemetry";

const logger = createLogger("memory.session-end");

/**
 * Session completion's memory step (spec R10): the session lifecycle knows a
 * session by project path and name, while memory binds notes to the exact
 * incarnation. This resolves the one from the other and hands the service a
 * completed incarnation, so the incarnation lookup lives in one place rather
 * than in every caller that finishes a session.
 */
export interface SessionMemoryFinalizerDeps {
  service: MemoryService;
  /**
   * Observation only (R15): the promotion-candidate half of the counter pair
   * that decides whether the passive affordance is measurably missed. A failed
   * counter never fails a completion.
   */
  telemetry: MemoryTelemetryService;
  findSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ readonly createdAt: string } | null>;
}

export interface SessionMemoryFinalizerInput {
  readonly projectPath: string;
  readonly sessionName: string;
}

export type SessionMemoryFinalizer = (
  input: SessionMemoryFinalizerInput,
) => Promise<void>;

/**
 * How many times a completion's memory step is attempted before it is left to
 * reconciliation. The realistic failure here is transient — a busy write queue,
 * a locked database — so a retry converts most would-be losses into a
 * completed archival. A permanent failure still does not strand the notes:
 * `finishSession` reconciles every over incarnation of the project, so the
 * next completion in the same project archives what this one could not.
 */
const FINALIZE_ATTEMPTS = 3;

export function createSessionMemoryFinalizer(
  deps: SessionMemoryFinalizerDeps,
): SessionMemoryFinalizer {
  return async ({ projectPath, sessionName }) => {
    const session = await deps.findSession(projectPath, sessionName);
    if (session === null) {
      // A session that is gone has no incarnation to bind notes to, and its
      // notes are unreachable anyway: nothing to archive, nothing to promote.
      logger.warn("memory.session_end.session_missing", {
        projectPath,
        sessionName,
      });
      return;
    }

    let result;
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await deps.service.finishSession({
          projectPath,
          session: {
            sessionName,
            sessionCreatedAt: session.createdAt,
          },
        });
        break;
      } catch (err) {
        if (attempt >= FINALIZE_ATTEMPTS) throw err;
        logger.warn("memory.session_end.attempt_failed", {
          projectPath,
          sessionName,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!result.ok) {
      logger.warn("memory.session_end.refused", {
        projectPath,
        sessionName,
        code: result.error.code,
        message: result.error.message,
      });
      return;
    }

    // The promotion-candidate count the spec logs so an unmissed passive
    // affordance can be told from a missed one (R10, D8, R15): the promoted
    // count is recorded by the promotion act itself, against the same note, so
    // the two are comparable per record rather than only in aggregate.
    try {
      await deps.telemetry.recordPromotionCandidates(
        result.value.promotionCandidates.map((note) => note.id),
      );
    } catch (err) {
      logger.warn("memory.session_end.candidate_telemetry_failed", {
        projectPath,
        sessionName,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("memory.session_end.completed", {
      projectPath,
      sessionName,
      sessionCreatedAt: session.createdAt,
      archived: result.value.archived.length,
      // State notes of EARLIER over incarnations this completion healed. A
      // non-zero count means a previous completion's memory step was lost.
      reconciled: result.value.reconciled.length,
      promotionCandidates: result.value.promotionCandidates.length,
    });
  };
}

/**
 * The production finalizer: the memory service and the session record the
 * lifecycle itself writes, so a completion reads the same row it just set.
 */
export async function finalizeSessionMemory(
  input: SessionMemoryFinalizerInput,
): Promise<void> {
  const { getStateStore } = await import("@/lib/state-store");
  const finalize = createSessionMemoryFinalizer({
    service: getMemoryService(),
    telemetry: getMemoryTelemetryService(),
    async findSession(projectPath, sessionName) {
      return getStateStore().getSession(projectPath, sessionName);
    },
  });
  return finalize(input);
}

/**
 * The durable recovery trigger for completion-time archival (R10).
 *
 * A completion's memory step can fail past its retries — a lock that outlives
 * them, a crash between the finished row and the write. Reconciling only at the
 * next completion in the same project is not enough: a project whose last
 * session has just completed would never run one. This sweep needs no queued
 * work item, because the outstanding work is already durable in the store — an
 * active `state` note whose incarnation is over IS the record of it — so every
 * server start finishes whatever the last one dropped. Idempotent.
 */
export async function reconcileSessionMemoryAtStartup(): Promise<number> {
  const result = await getMemoryService().reconcileSessionMemory();
  if (!result.ok) {
    logger.warn("memory.session_end.reconcile_refused", {
      code: result.error.code,
      message: result.error.message,
    });
    return 0;
  }
  return result.value.archived.length;
}
