/**
 * Lane service for the workflow primitive layer.
 *
 * Resolves the active continuity context for lane-backed agent calls and
 * applies post-turn outcomes back to lane state. Backend-specific outcome
 * fields are kept in discriminated branches so the service never invents
 * unsupported metrics — Codex never carries `contextTokens`/`contextWindowMax`,
 * Claude never carries Codex `lastTurnUsage`.
 *
 * The service is feature-neutral: it does not create conversations or open
 * Codex threads. Callers seed a lane via `initialize()` once they have the
 * backend reference, then route post-turn metadata through `recordOutcome()`.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { agentBackendSchema } from "@/lib/schemas";
import type { LaneStore } from "./lane-store";
import {
  laneStateSchema,
  type CodexLaneTurnUsage,
  type LaneRef,
  type LaneState,
} from "./lane-vocabulary";

const logger = createLogger("workflows.primitives.lane.service");

const codexLaneTurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const claudeLaneOutcomeSchema = z
  .object({
    backend: z.literal("claude"),
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindowMax: z.number().int().positive().optional(),
    contextLimitTokens: z.number().int().positive().optional(),
    conversationId: z.string().min(1).optional(),
    staleSession: z.boolean().optional(),
    failed: z.boolean().optional(),
  })
  .strict();

const codexLaneOutcomeSchema = z
  .object({
    backend: z.literal("codex"),
    threadId: z.string().min(1).optional(),
    lastTurnUsage: codexLaneTurnUsageSchema.nullable().optional(),
    contextLimitTokens: z.number().int().positive().optional(),
    staleSession: z.boolean().optional(),
    failed: z.boolean().optional(),
  })
  .strict();

const laneOutcomeSchema = z.discriminatedUnion("backend", [
  claudeLaneOutcomeSchema,
  codexLaneOutcomeSchema,
]);
export type LaneOutcome = z.infer<typeof laneOutcomeSchema>;

export interface LaneServiceDeps {
  store: LaneStore;
  now?: () => string;
}

export interface LaneService {
  resolve(ref: LaneRef): Promise<LaneState | null>;
  initialize(state: LaneState): Promise<LaneState>;
  recordOutcome(ref: LaneRef, outcome: LaneOutcome): Promise<LaneState>;
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
      const parsedOutcome = laneOutcomeSchema.parse(outcome);
      const existing = await store.read(ref);
      if (!existing) {
        throw new Error(
          `lane ${ref.workflowId}/${ref.laneId} is not initialized; call initialize() first`,
        );
      }
      // Re-validate parity since outside callers might bypass the schema.
      agentBackendSchema.parse(existing.backend);
      if (parsedOutcome.backend !== existing.backend) {
        throw new Error(
          `lane outcome backend (${parsedOutcome.backend}) does not match lane backend (${existing.backend})`,
        );
      }

      const updated = applyOutcome(existing, parsedOutcome, now());
      const reparsed = laneStateSchema.parse(updated);
      await store.write(reparsed);

      logger.debug("lane.service.record_outcome", {
        workflowId: reparsed.workflowId,
        laneId: reparsed.laneId,
        backend: reparsed.backend,
        rotateBeforeNextTurn: reparsed.metrics.rotateBeforeNextTurn,
        staleSession:
          reparsed.backendState.backend === "claude"
            ? reparsed.backendState.staleSession
            : reparsed.backendState.staleSession,
      });
      return reparsed;
    },
  };
}

function applyOutcome(
  existing: LaneState,
  outcome: LaneOutcome,
  timestamp: string,
): LaneState {
  if (outcome.backend === "claude") {
    return applyClaudeOutcome(existing, outcome, timestamp);
  }
  return applyCodexOutcome(existing, outcome, timestamp);
}

function applyClaudeOutcome(
  existing: LaneState,
  outcome: Extract<LaneOutcome, { backend: "claude" }>,
  timestamp: string,
): LaneState {
  if (existing.backendState.backend !== "claude") {
    throw new Error("lane backendState branch mismatched at outcome time");
  }
  if (existing.metrics.backend !== "claude") {
    throw new Error("lane metrics branch mismatched at outcome time");
  }

  const limit =
    outcome.contextLimitTokens ?? existing.policy.contextLimitTokens;

  const nextRotate = (() => {
    if (limit === undefined) return existing.metrics.rotateBeforeNextTurn;
    if (outcome.contextTokens === undefined) {
      return existing.metrics.rotateBeforeNextTurn;
    }
    return outcome.contextTokens > limit;
  })();

  const nextBackendState: LaneState["backendState"] = {
    backend: "claude",
    ...(outcome.conversationId !== undefined
      ? { conversationId: outcome.conversationId }
      : existing.backendState.conversationId !== undefined
        ? { conversationId: existing.backendState.conversationId }
        : {}),
    ...(outcome.staleSession !== undefined
      ? { staleSession: outcome.staleSession }
      : existing.backendState.staleSession !== undefined
        ? { staleSession: existing.backendState.staleSession }
        : {}),
  };

  const nextMetrics: LaneState["metrics"] = {
    backend: "claude",
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
    rotateBeforeNextTurn: nextRotate,
  };

  return {
    ...existing,
    backendState: nextBackendState,
    metrics: nextMetrics,
    lastUsedAt: timestamp,
  };
}

function applyCodexOutcome(
  existing: LaneState,
  outcome: Extract<LaneOutcome, { backend: "codex" }>,
  timestamp: string,
): LaneState {
  if (existing.backendState.backend !== "codex") {
    throw new Error("lane backendState branch mismatched at outcome time");
  }
  if (existing.metrics.backend !== "codex") {
    throw new Error("lane metrics branch mismatched at outcome time");
  }

  const nextBackendState: LaneState["backendState"] = {
    backend: "codex",
    ...(outcome.threadId !== undefined
      ? { threadId: outcome.threadId }
      : existing.backendState.threadId !== undefined
        ? { threadId: existing.backendState.threadId }
        : {}),
    ...(outcome.staleSession !== undefined
      ? { staleSession: outcome.staleSession }
      : existing.backendState.staleSession !== undefined
        ? { staleSession: existing.backendState.staleSession }
        : {}),
  };

  const nextLastTurnUsage: CodexLaneTurnUsage | null | undefined =
    outcome.lastTurnUsage !== undefined
      ? outcome.lastTurnUsage
      : existing.metrics.lastTurnUsage;

  const nextMetrics: LaneState["metrics"] = {
    backend: "codex",
    ...(nextLastTurnUsage !== undefined
      ? { lastTurnUsage: nextLastTurnUsage }
      : {}),
    rotateBeforeNextTurn: outcome.failed === true,
  };

  return {
    ...existing,
    backendState: nextBackendState,
    metrics: nextMetrics,
    lastUsedAt: timestamp,
  };
}
