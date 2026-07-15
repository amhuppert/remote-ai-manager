/**
 * Lane service for the workflow primitive layer.
 *
 * Resolves the active continuity context for lane-backed agent calls and
 * applies post-turn outcomes back to lane state. The outcome shape is
 * backend-neutral: metric fields are optional and merge onto the lane's
 * normalized metrics, so the service never invents unsupported values — a
 * backend that reports no context-window occupancy simply records none, and
 * the context-limit gate reads metric availability from the backend's
 * registered descriptor rather than from its identity.
 *
 * The service is feature-neutral: it does not create conversations or open
 * backend threads. Callers seed a lane via `initialize()` once they have the
 * continuity handle, then route post-turn metadata through `recordOutcome()`.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { continuationDispositionSchema } from "@/lib/agent-backends/errors";
import { agentBackendIdShapeSchema } from "@/lib/shared/schemas";
import {
  evaluateContextLimit,
  type ContextLimitEvaluation,
} from "./context-limit-gate";
import type { LaneStore } from "./lane-store";
import {
  laneStateSchema,
  laneTurnUsageSchema,
  type LaneRef,
  type LaneState,
} from "./lane-vocabulary";

const logger = createLogger("workflows.primitives.lane.service");

const laneOutcomeSchema = z
  .object({
    /** Owning backend; must match the lane's backend (guarded at apply time). */
    backend: agentBackendIdShapeSchema,
    /** Updated continuity handle reported by the turn, when one was minted. */
    ref: z.string().min(1).optional(),
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindowMax: z.number().int().positive().optional(),
    contextLimitTokens: z.number().int().positive().optional(),
    lastTurnUsage: laneTurnUsageSchema.nullable().optional(),
    staleSession: z.boolean().optional(),
    /** Adapter verdict for the lane's continuation after this turn. */
    continuationDisposition: continuationDispositionSchema.optional(),
    /**
     * True when the turn auto-compacted. Outcome-scoped (not persisted into
     * lane metrics): it enters the rotation decision as a separate input
     * because a compaction deflates the occupancy reading below the limit.
     */
    compactedThisTurn: z.boolean().optional(),
  })
  .strict();
export type LaneOutcome = z.infer<typeof laneOutcomeSchema>;

export interface LaneServiceDeps {
  store: LaneStore;
  now?: () => string;
}

export interface RecordOutcomeResult {
  state: LaneState;
  contextLimitEvaluation: ContextLimitEvaluation;
}

export interface LaneService {
  resolve(ref: LaneRef): Promise<LaneState | null>;
  initialize(state: LaneState): Promise<LaneState>;
  recordOutcome(
    ref: LaneRef,
    outcome: LaneOutcome,
  ): Promise<RecordOutcomeResult>;
}

export function createLaneService(deps: LaneServiceDeps): LaneService {
  const now = deps.now ?? (() => new Date().toISOString());
  const { store } = deps;

  return {
    async resolve(ref) {
      return store.read(ref);
    },

    async initialize(state) {
      const seeded: LaneState = laneStateSchema.parse({
        ...state,
        lastUsedAt: now(),
      });
      await store.write(seeded);
      logger.info("lane.service.initialize", {
        workflowId: seeded.workflowId,
        laneId: seeded.laneId,
        backend: seeded.backend,
      });
      return seeded;
    },

    async recordOutcome(ref, outcome) {
      const existing = await store.read(ref);
      if (!existing) {
        throw new Error(
          `lane ${ref.workflowId}/${ref.laneId} is not initialized; call initialize() first`,
        );
      }

      const { state: reparsed, contextLimitEvaluation } = deriveLaneOutcome(
        existing,
        outcome,
        now(),
      );
      await store.write(reparsed);

      logger.debug("lane.service.record_outcome", {
        workflowId: reparsed.workflowId,
        laneId: reparsed.laneId,
        backend: reparsed.backend,
        rotateBeforeNextTurn: reparsed.metrics.rotateBeforeNextTurn,
        contextLimitEvaluation,
        staleSession: reparsed.staleSession,
      });
      return { state: reparsed, contextLimitEvaluation };
    },
  };
}

/**
 * The lane service's post-turn decision as a pure function: it owns the
 * backend-match guard, the context-limit verdict, and the next lane state.
 * Callers that persist through their own atomic critical section (the graph
 * lane continuity records its outcome and its graph-only `limitEvaluation` in
 * one execution mutation) invoke this against a lane state they have already
 * read inside that section, so the decision stays here while the durable write
 * happens once at the call site.
 */
export function deriveLaneOutcome(
  existing: LaneState,
  outcome: LaneOutcome,
  timestamp: string,
): RecordOutcomeResult {
  const parsedOutcome = laneOutcomeSchema.parse(outcome);
  if (parsedOutcome.backend !== existing.backend) {
    throw new Error(
      `lane outcome backend (${parsedOutcome.backend}) does not match lane backend (${existing.backend})`,
    );
  }
  const { state, contextLimitEvaluation } = applyOutcome(
    existing,
    parsedOutcome,
    timestamp,
  );
  return { state: laneStateSchema.parse(state), contextLimitEvaluation };
}

function applyOutcome(
  existing: LaneState,
  outcome: LaneOutcome,
  timestamp: string,
): RecordOutcomeResult {
  const limit =
    outcome.contextLimitTokens ?? existing.policy.contextLimitTokens;

  const evaluation = evaluateContextLimit({
    metrics: {
      backend: existing.backend,
      ...(outcome.contextTokens !== undefined
        ? { contextTokens: outcome.contextTokens }
        : {}),
      rotateBeforeNextTurn: existing.metrics.rotateBeforeNextTurn,
    },
    policy: { contextLimitTokens: limit },
    ...(outcome.compactedThisTurn !== undefined
      ? { compactedThisTurn: outcome.compactedThisTurn }
      : {}),
  });

  const nextRotate =
    evaluation === "rotation_required" ||
    outcome.continuationDisposition === "clear";

  const nextMetrics: LaneState["metrics"] = {
    ...(outcome.contextTokens !== undefined
      ? { contextTokens: outcome.contextTokens }
      : existing.metrics.contextTokens !== undefined
        ? { contextTokens: existing.metrics.contextTokens }
        : {}),
    ...(outcome.contextWindowMax !== undefined
      ? { contextWindowMax: outcome.contextWindowMax }
      : existing.metrics.contextWindowMax !== undefined
        ? { contextWindowMax: existing.metrics.contextWindowMax }
        : {}),
    ...(outcome.lastTurnUsage !== undefined
      ? { lastTurnUsage: outcome.lastTurnUsage }
      : existing.metrics.lastTurnUsage !== undefined
        ? { lastTurnUsage: existing.metrics.lastTurnUsage }
        : {}),
    rotateBeforeNextTurn: nextRotate,
  };

  const nextStaleSession =
    outcome.staleSession !== undefined
      ? outcome.staleSession
      : existing.staleSession;

  return {
    state: {
      ...existing,
      ref: outcome.ref ?? existing.ref,
      ...(nextStaleSession !== undefined
        ? { staleSession: nextStaleSession }
        : {}),
      metrics: nextMetrics,
      lastUsedAt: timestamp,
    },
    contextLimitEvaluation: evaluation,
  };
}
