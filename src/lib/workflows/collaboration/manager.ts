/**
 * Collaboration Mode manager.
 *
 * The thin glue between an HTTP entrypoint and `runAsymmetricCollaborationSlice`.
 * The manager:
 *
 *  - validates the start request (Zod schema mirrors the route body),
 *  - resolves the session worktree path so the slice writes artifacts under
 *    `SessionState.worktreePath` only (per the worktree-isolation rule in
 *    CLAUDE.md),
 *  - constructs production deps via `createCollaborationDeps`,
 *  - kicks off `runAsymmetricCollaborationSlice` in the background so the route
 *    can return a `workflowId` immediately (rounds take minutes; the UI polls
 *    the envelope status for progress),
 *  - exposes `getEnvelope` and `listActive` so the route layer can answer
 *    status questions without re-implementing the repository wiring.
 *
 * The manager keeps the agent-call factory injectable so tests can supply a
 * deterministic `callAgent` without exercising the heavy production runtime
 * resolvers. Production wiring of `callAgent` (`executeAgentCall` with
 * `resolveConversationRuntime`/`resolveTaskRunner` resolvers) is a follow-up
 * concern: this module does NOT bake in those resolvers, so changing them
 * later does not require touching the manager's contract.
 */

import path from "node:path";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  runAsymmetricCollaborationSlice,
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
  type AsymmetricCollaborationSliceResult,
  type AsymmetricDispatchInfo,
} from "./envelope";
import { createCollaborationDeps } from "./deps-factory";
import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import {
  createLaneService,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  getDefaultCodexModel,
  type AgentSessionRef,
} from "@/lib/agent-backends/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { collaborationAutonomousResolutionThresholdSchema } from "./types";
import { dispatchPushForCollaborationEvent } from "@/lib/push-notification/dispatcher";
import {
  publishScopedStatusEvent,
  type PublishScopedStatusEventInput,
} from "@/lib/workflows/primitives/default-session-status-bus";

function extractConversationIdFromEnvelope(
  envelope: WorkflowEnvelope,
): string | null {
  const snapshot = envelope.featureSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const candidate = (snapshot as Record<string, unknown>)["conversationId"];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function extractCompletedRounds(snapshot: Record<string, unknown>): number {
  const candidate = snapshot["negotiationRoundsCompleted"];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : 0;
}

async function markConversationAwaitingAfterSliceThrow(input: {
  sliceDeps: AsymmetricCollaborationSliceDeps;
  projectPath: string;
  sessionName: string;
  workflowId: string;
  conversationId: string;
  timestamp: string;
  error: unknown;
}): Promise<void> {
  if (!input.sliceDeps.markConversationAwaiting) return;

  try {
    await input.sliceDeps.markConversationAwaiting(input.conversationId, {
      workflowId: input.workflowId,
      timestamp: input.timestamp,
    });
  } catch (err) {
    logger.warn("collaboration.manager.slice_throw_metadata_sync_failed", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      sliceError: getErrorMessage(input.error),
      error: getErrorMessage(err),
    });
  }
}

async function markEnvelopeFailedAfterSliceThrow(input: {
  deps: Pick<
    CollaborationManagerDeps,
    "createEnvelopeRepository" | "publishStatus" | "now"
  >;
  projectPath: string;
  sessionName: string;
  workflowId: string;
  error: unknown;
}): Promise<void> {
  const errorSummary = getErrorMessage(input.error);
  try {
    const repo = input.deps.createEnvelopeRepository({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
    await repo.update(input.workflowId, {
      status: "failed",
      phase: "failed_unhandled",
      errorSummary,
    });
    input.deps.publishStatus({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      workflowId: input.workflowId,
      status: "failed",
      timestamp: input.deps.now(),
      payload: {
        kind: "asymmetric_failed",
        flowAgent: "unknown",
        errorSummary,
      },
    });
  } catch (err) {
    logger.warn("collaboration.manager.slice_throw_envelope_failed", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      workflowId: input.workflowId,
      sliceError: errorSummary,
      error: getErrorMessage(err),
    });
  }
}

const logger = createLogger("workflows.collaboration.manager");

export const collaborationStartRequestSchema = z.object({
  brief: z.string().trim().min(1, "brief is required"),
  negotiationRounds: z.number().int().min(1).max(20),
  autonomousResolutionThreshold:
    collaborationAutonomousResolutionThresholdSchema,
  conversationId: z.string().trim().min(1, "conversationId is required"),
  // The user's currently-selected backend in the UI. The route handler adopts
  // this onto the conversation (mirroring executePromptStream) before the
  // manager reads `conversation.agentBackend` to pick Agent One. Optional so
  // older clients and direct API callers keep working.
  backend: agentBackendSchema.optional(),
});
type CollaborationStartRequest = z.infer<
  typeof collaborationStartRequestSchema
>;

export const collaborationResumeRequestSchema = z.object({
  resumeToken: z.string().trim().min(1, "resumeToken is required"),
  conversationId: z.string().trim().min(1, "conversationId is required"),
  userAnswers: z.record(z.string(), z.string()).default({}),
});
type CollaborationResumeRequest = z.infer<
  typeof collaborationResumeRequestSchema
>;

export const collaborationStopRequestSchema = z.object({
  conversationId: z.string().trim().min(1, "conversationId is required"),
});
type CollaborationStopRequest = z.infer<typeof collaborationStopRequestSchema>;

interface CollaborationManagerStartInput extends CollaborationStartRequest {
  projectPath: string;
  sessionName: string;
}

interface CollaborationManagerStartResult {
  workflowId: string;
  status: "started";
}

interface CollaborationManagerStopInput extends CollaborationStopRequest {
  projectPath: string;
  sessionName: string;
  workflowId: string;
}

interface CollaborationManagerStopResult {
  workflowId: string;
  status: "stopped";
}

interface CollaborationManagerSessionResolution {
  worktreePath: string;
}

interface CollaborationManagerConversationResolution {
  agentBackend: AgentBackendId;
  /**
   * The conversation's stored backend session ref. The manager forwards
   * this onto the slice as `priorBackendRef` so Agent One's first turn can
   * resume the originating conversation's backend session.
   */
  backendRef?: AgentSessionRef | null;
}

export interface CollaborationManagerDeps {
  /**
   * Resolves the session worktree path the slice will write artifacts under.
   * Returning `null` means the session does not exist; the manager surfaces
   * this as a typed error to the caller.
   */
  resolveSession(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<CollaborationManagerSessionResolution | null>;

  /**
   * Resolves the active conversation referenced by the start payload so the
   * manager can derive the originating agent (and synthesizer) from the
   * conversation's `agentBackend`. Returning `null` means the conversation
   * does not exist within the session; the manager surfaces this as a typed
   * error to the caller.
   */
  resolveConversation(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<CollaborationManagerConversationResolution | null>;

  /**
   * Tracks abort signals for in-flight collaboration runs so a stop request
   * can interrupt the slice between rounds. The default implementation uses
   * a process-local Map keyed by `workflowId`. Tests can substitute a
   * deterministic registry to assert stop signaling without relying on
   * shared module state.
   */
  stopRegistry: CollaborationStopRegistry;

  /**
   * Builds the slice deps. Production wiring composes `createCollaborationDeps`
   * with a real `callAgent`; tests inject deterministic deps here. Receives
   * an optional `laneService` so the manager can share one LaneService
   * between this and `buildCallAgent` — that's required for production WAC
   * post-turn outcomes to hit the same lane state the slice operates on.
   */
  createDeps(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    callAgent: AsymmetricCollaborationSliceDeps["callAgent"];
    laneService?: LaneService;
  }): AsymmetricCollaborationSliceDeps;

  /**
   * Constructs the per-run LaneService that the manager will share between
   * `buildCallAgent` (for WAC continuity / outcome bookkeeping) and
   * `createDeps` (for the slice's lane initialization, scheduling, and
   * recordOutcome calls). Tests can override this to produce a fake
   * LaneService that does not need to be shared.
   */
  buildLaneService(input: {
    projectPath: string;
    sessionName: string;
  }): LaneService;

  /**
   * Builds the per-run `callAgent`. Kept separate from `createDeps` so the
   * agent-call wiring can evolve independently of the deps shape. The
   * manager passes the same `laneService` it gives to `createDeps` so the
   * production WAC's lane outcome bookkeeping lands on the same lane state
   * the slice's `recordOutcome` writes to.
   */
  buildCallAgent(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    workflowId: string;
    conversationId: string;
    laneService: LaneService;
    codexModel: string;
    codexReasoningEffort?: string;
  }): AsymmetricCollaborationSliceDeps["callAgent"];

  /**
   * Resolves the Codex lane's model + reasoning effort from the global config
   * cascade. Standalone Collaboration mode carries no per-call model, so the
   * resolved model is threaded to the Codex lane to avoid the Codex SDK's
   * built-in default (rejected for ChatGPT-account auth). Defaults to reading
   * the singleton global config; tests inject a deterministic value.
   */
  resolveCodexModelConfig(): Promise<{
    model: string;
    reasoningEffort?: string;
  }>;

  /**
   * Runs the slice. Production uses the imported
   * `runAsymmetricCollaborationSlice`; tests can substitute a deterministic
   * implementation that resolves with a scripted result.
   */
  runSlice(
    input: AsymmetricCollaborationSliceInput,
    deps: AsymmetricCollaborationSliceDeps,
  ): Promise<AsymmetricCollaborationSliceResult>;

  /**
   * Builds the envelope repository scoped to a single session. Defaults to
   * the production session-state-backed factory.
   */
  createEnvelopeRepository(input: {
    projectPath: string;
    sessionName: string;
  }): WorkflowEnvelopeRepository;

  publishStatus(
    input: Omit<
      PublishScopedStatusEventInput,
      "scope" | "scopeId" | "projectName" | "sessionName"
    > & {
      projectPath: string;
      sessionName: string;
      workflowId: string;
    },
  ): void;

  dispatchPush(
    input: AsymmetricDispatchInfo & {
      projectPath: string;
      sessionName: string;
    },
  ): void;

  newWorkflowId(): string;
  now(): string;
}

/**
 * Registers and signals abort controllers per workflow so the manager can
 * interrupt a running slice when a stop request arrives. The slice is
 * expected to observe `signalFor(workflowId)` between rounds and break out
 * to a `completed_unresolved` finalization with reason `user_stopped`.
 */
export interface CollaborationStopRegistry {
  register(workflowId: string): AbortController;
  signal(workflowId: string): boolean;
  signalFor(workflowId: string): AbortSignal | null;
  release(workflowId: string): void;
}

export function createInMemoryCollaborationStopRegistry(): CollaborationStopRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    register(workflowId) {
      const controller = new AbortController();
      controllers.set(workflowId, controller);
      return controller;
    },
    signal(workflowId) {
      const controller = controllers.get(workflowId);
      if (!controller) return false;
      if (!controller.signal.aborted) controller.abort();
      return true;
    },
    signalFor(workflowId) {
      return controllers.get(workflowId)?.signal ?? null;
    },
    release(workflowId) {
      controllers.delete(workflowId);
    },
  };
}

const defaultStopRegistry = createInMemoryCollaborationStopRegistry();

const defaultBuildCallAgent: CollaborationManagerDeps["buildCallAgent"] = (
  input,
) =>
  createCollaborationProductionCallAgent({
    workflowId: input.workflowId,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    sessionKey: `${input.projectPath}::${input.sessionName}`,
    originatingConversationId: input.conversationId,
    laneService: input.laneService,
    codexModel: input.codexModel,
    ...(input.codexReasoningEffort !== undefined
      ? { codexReasoningEffort: input.codexReasoningEffort }
      : {}),
  });

const defaultDeps: CollaborationManagerDeps = {
  async resolveSession(input) {
    const session = await defaultGetSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) return null;
    return { worktreePath: session.worktreePath };
  },
  async resolveConversation(input) {
    const conv = await defaultGetConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    if (!conv) return null;
    return { agentBackend: conv.agentBackend, backendRef: conv.backendRef };
  },
  stopRegistry: defaultStopRegistry,
  createDeps(input) {
    return createCollaborationDeps({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      callAgent: input.callAgent,
      ...(input.laneService ? { laneService: input.laneService } : {}),
    });
  },
  buildLaneService: (input) =>
    createLaneService({
      store: createSessionLaneStoreForProduction({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      }),
    }),
  buildCallAgent: defaultBuildCallAgent,
  async resolveCodexModelConfig() {
    const config = await defaultReadConfig();
    return {
      model: config.codex?.model ?? getDefaultCodexModel(),
      ...(config.codex?.reasoningEffort !== undefined
        ? { reasoningEffort: config.codex.reasoningEffort }
        : {}),
    };
  },
  runSlice: runAsymmetricCollaborationSlice,
  createEnvelopeRepository(input) {
    return createSessionWorkflowEnvelopeRepositoryForProduction({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
  },
  publishStatus(input) {
    const projectName = path.basename(input.projectPath);
    const outcome = publishScopedStatusEvent({
      scope: "collaboration",
      scopeId: input.workflowId,
      status: input.status,
      timestamp: input.timestamp,
      projectName,
      sessionName: input.sessionName,
      payload: input.payload,
      reason: input.reason,
    });
    if (!outcome.delivered) {
      logger.warn("collaboration.manager.status_bus.sse_delivery_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId: input.workflowId,
        status: input.status,
        error: outcome.error ? getErrorMessage(outcome.error) : "unknown",
      });
    }
  },
  dispatchPush(input) {
    dispatchPushForCollaborationEvent({
      ...input,
      projectName: path.basename(input.projectPath),
    });
  },
  newWorkflowId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

export class CollaborationSessionNotFoundError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly sessionName: string,
  ) {
    super(`Session "${sessionName}" not found under project "${projectPath}"`);
    this.name = "CollaborationSessionNotFoundError";
  }
}

export class CollaborationConversationNotFoundError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly sessionName: string,
    public readonly conversationId: string,
  ) {
    super(
      `Conversation "${conversationId}" not found in session "${sessionName}" under project "${projectPath}"`,
    );
    this.name = "CollaborationConversationNotFoundError";
  }
}

export class CollaborationWorkflowNotFoundError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Collaboration workflow "${workflowId}" not found`);
    this.name = "CollaborationWorkflowNotFoundError";
  }
}

export class CollaborationResumeTokenMismatchError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Resume token does not match workflow "${workflowId}"`);
    this.name = "CollaborationResumeTokenMismatchError";
  }
}

export class CollaborationConversationMismatchError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly expectedConversationId: string,
    public readonly suppliedConversationId: string,
  ) {
    super(
      `Workflow "${workflowId}" belongs to conversation "${expectedConversationId}", not "${suppliedConversationId}"`,
    );
    this.name = "CollaborationConversationMismatchError";
  }
}

export class CollaborationNotPausedError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly status: string,
  ) {
    super(
      `Workflow "${workflowId}" is not paused (status=${status}); resume only valid for paused workflows`,
    );
    this.name = "CollaborationNotPausedError";
  }
}

export class CollaborationNotStoppableError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly status: string,
  ) {
    super(
      `Workflow "${workflowId}" is not stoppable (status=${status}); stop only valid for running or paused workflows`,
    );
    this.name = "CollaborationNotStoppableError";
  }
}

interface CollaborationManagerResumeInput extends CollaborationResumeRequest {
  projectPath: string;
  sessionName: string;
  workflowId: string;
}

interface CollaborationManagerResumeResult {
  workflowId: string;
  status: "resumed";
}

export interface CollaborationManager {
  start(
    input: CollaborationManagerStartInput,
  ): Promise<CollaborationManagerStartResult>;
  resume(
    input: CollaborationManagerResumeInput,
  ): Promise<CollaborationManagerResumeResult>;
  stop(
    input: CollaborationManagerStopInput,
  ): Promise<CollaborationManagerStopResult>;
  getEnvelope(input: {
    projectPath: string;
    sessionName: string;
    workflowId: string;
  }): Promise<WorkflowEnvelope | null>;
  listActive(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<WorkflowEnvelope[]>;
  listAll(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<WorkflowEnvelope[]>;
}

export function createCollaborationManager(
  overrides: Partial<CollaborationManagerDeps> = {},
): CollaborationManager {
  const deps: CollaborationManagerDeps = { ...defaultDeps, ...overrides };

  return {
    async start(input) {
      const parsed = collaborationStartRequestSchema.parse({
        brief: input.brief,
        negotiationRounds: input.negotiationRounds,
        autonomousResolutionThreshold: input.autonomousResolutionThreshold,
        conversationId: input.conversationId,
      });

      const session = await deps.resolveSession({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      if (!session) {
        throw new CollaborationSessionNotFoundError(
          input.projectPath,
          input.sessionName,
        );
      }

      const conversation = await deps.resolveConversation({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: parsed.conversationId,
      });
      if (!conversation) {
        throw new CollaborationConversationNotFoundError(
          input.projectPath,
          input.sessionName,
          parsed.conversationId,
        );
      }

      const primaryAgentBackend: AgentBackendId = conversation.agentBackend;

      const workflowId = deps.newWorkflowId();
      const sessionKey = `${input.projectPath}::${input.sessionName}`;

      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const codexModelConfig = await deps.resolveCodexModelConfig();

      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId,
        conversationId: parsed.conversationId,
        laneService,
        codexModel: codexModelConfig.model,
        ...(codexModelConfig.reasoningEffort !== undefined
          ? { codexReasoningEffort: codexModelConfig.reasoningEffort }
          : {}),
      });

      const sliceDeps = deps.createDeps({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        callAgent,
        laneService,
      });

      const stopController = deps.stopRegistry.register(workflowId);

      const sliceInput: AsymmetricCollaborationSliceInput = {
        workflowId,
        brief: parsed.brief,
        worktreePath: session.worktreePath,
        sessionKey,
        primaryAgentBackend,
        negotiationRounds: parsed.negotiationRounds,
        autonomousResolutionThreshold: parsed.autonomousResolutionThreshold,
        conversationId: parsed.conversationId,
        priorBackendRef: conversation.backendRef ?? undefined,
        stopSignal: stopController.signal,
      };

      logger.info("collaboration.manager.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId,
        negotiationRounds: parsed.negotiationRounds,
        autonomousResolutionThreshold: parsed.autonomousResolutionThreshold,
        primaryAgentBackend,
        conversationId: parsed.conversationId,
        priorBackendRefBackend: conversation.backendRef?.backend ?? null,
      });

      void deps
        .runSlice(sliceInput, sliceDeps)
        .then((result) => {
          logger.info("collaboration.manager.slice_finished", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            kind: result.kind,
          });
        })
        .catch(async (err) => {
          logger.error("collaboration.manager.slice_threw", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            error: getErrorMessage(err),
          });
          await markEnvelopeFailedAfterSliceThrow({
            deps,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            error: err,
          });
          await markConversationAwaitingAfterSliceThrow({
            sliceDeps,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId,
            conversationId: parsed.conversationId,
            timestamp: deps.now(),
            error: err,
          });
        })
        .finally(() => {
          deps.stopRegistry.release(workflowId);
        });

      return { workflowId, status: "started" };
    },

    async resume(input) {
      const parsed = collaborationResumeRequestSchema.parse({
        resumeToken: input.resumeToken,
        conversationId: input.conversationId,
        userAnswers: input.userAnswers,
      });

      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const envelope = await repo.get(input.workflowId);
      if (!envelope) {
        throw new CollaborationWorkflowNotFoundError(input.workflowId);
      }
      const ownedConversationId = extractConversationIdFromEnvelope(envelope);
      if (
        ownedConversationId === null ||
        ownedConversationId !== parsed.conversationId
      ) {
        throw new CollaborationConversationMismatchError(
          input.workflowId,
          ownedConversationId ?? "<unknown>",
          parsed.conversationId,
        );
      }
      if (envelope.status !== "paused") {
        throw new CollaborationNotPausedError(
          input.workflowId,
          envelope.status,
        );
      }
      if (envelope.pause?.resumeToken !== parsed.resumeToken) {
        throw new CollaborationResumeTokenMismatchError(input.workflowId);
      }

      const session = await deps.resolveSession({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      if (!session) {
        throw new CollaborationSessionNotFoundError(
          input.projectPath,
          input.sessionName,
        );
      }

      const existingSnapshot =
        envelope.featureSnapshot &&
        typeof envelope.featureSnapshot === "object" &&
        !Array.isArray(envelope.featureSnapshot)
          ? (envelope.featureSnapshot as Record<string, unknown>)
          : {};

      const brief =
        typeof existingSnapshot["brief"] === "string"
          ? (existingSnapshot["brief"] as string)
          : "";
      const negotiationRounds =
        typeof existingSnapshot["negotiationRounds"] === "number"
          ? (existingSnapshot["negotiationRounds"] as number)
          : 5;
      const primaryAgentBackend: AgentBackendId =
        existingSnapshot["primaryAgentBackend"] === "claude" ||
        existingSnapshot["primaryAgentBackend"] === "codex"
          ? (existingSnapshot["primaryAgentBackend"] as AgentBackendId)
          : "claude";
      const autonomousResolutionThreshold =
        collaborationAutonomousResolutionThresholdSchema.safeParse(
          existingSnapshot["autonomousResolutionThreshold"],
        );
      const conversationId = parsed.conversationId;
      const completedRounds = extractCompletedRounds(existingSnapshot);

      const priorAnswersByQuestionId =
        existingSnapshot["userAnswersByQuestionId"] &&
        typeof existingSnapshot["userAnswersByQuestionId"] === "object" &&
        !Array.isArray(existingSnapshot["userAnswersByQuestionId"])
          ? (existingSnapshot["userAnswersByQuestionId"] as Record<
              string,
              string
            >)
          : {};
      const userAnswersByQuestionId: Record<string, string> = {
        ...priorAnswersByQuestionId,
        ...parsed.userAnswers,
      };

      const updatedSnapshot: Record<string, unknown> = {
        ...existingSnapshot,
        userAnswersByQuestionId,
      };

      await repo.update(input.workflowId, {
        featureSnapshot: updatedSnapshot,
      });
      await repo.markRunning(input.workflowId);

      const sessionKey = `${input.projectPath}::${input.sessionName}`;
      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const codexModelConfig = await deps.resolveCodexModelConfig();
      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId: input.workflowId,
        conversationId,
        laneService,
        codexModel: codexModelConfig.model,
        ...(codexModelConfig.reasoningEffort !== undefined
          ? { codexReasoningEffort: codexModelConfig.reasoningEffort }
          : {}),
      });
      const sliceDeps = deps.createDeps({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        callAgent,
        laneService,
      });

      const stopController = deps.stopRegistry.register(input.workflowId);

      const sliceInput: AsymmetricCollaborationSliceInput = {
        workflowId: input.workflowId,
        brief,
        worktreePath: session.worktreePath,
        sessionKey,
        primaryAgentBackend,
        negotiationRounds,
        autonomousResolutionThreshold: autonomousResolutionThreshold.success
          ? autonomousResolutionThreshold.data
          : "major",
        conversationId,
        stopSignal: stopController.signal,
        resume: { userAnswersByQuestionId },
      };

      logger.info("collaboration.manager.resume", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId: input.workflowId,
        userAnswerCount: Object.keys(parsed.userAnswers).length,
        completedRounds,
      });

      void deps
        .runSlice(sliceInput, sliceDeps)
        .then((result) => {
          logger.info("collaboration.manager.resume_slice_finished", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            kind: result.kind,
          });
        })
        .catch(async (err) => {
          logger.error("collaboration.manager.resume_slice_threw", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            error: getErrorMessage(err),
          });
          await markEnvelopeFailedAfterSliceThrow({
            deps,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            error: err,
          });
          await markConversationAwaitingAfterSliceThrow({
            sliceDeps,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            conversationId,
            timestamp: deps.now(),
            error: err,
          });
        })
        .finally(() => {
          deps.stopRegistry.release(input.workflowId);
        });

      return { workflowId: input.workflowId, status: "resumed" as const };
    },

    async stop(input) {
      const parsed = collaborationStopRequestSchema.parse({
        conversationId: input.conversationId,
      });

      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const envelope = await repo.get(input.workflowId);
      if (!envelope) {
        throw new CollaborationWorkflowNotFoundError(input.workflowId);
      }
      const ownedConversationId = extractConversationIdFromEnvelope(envelope);
      if (
        ownedConversationId === null ||
        ownedConversationId !== parsed.conversationId
      ) {
        throw new CollaborationConversationMismatchError(
          input.workflowId,
          ownedConversationId ?? "<unknown>",
          parsed.conversationId,
        );
      }
      if (envelope.status !== "running" && envelope.status !== "paused") {
        throw new CollaborationNotStoppableError(
          input.workflowId,
          envelope.status,
        );
      }

      // Signal any in-flight slice so it can break out between rounds. The
      // slice is responsible for transitioning the envelope to the
      // unresolved terminal state via finalizeUnresolved.
      const signaled = deps.stopRegistry.signal(input.workflowId);

      // Always perform a direct envelope transition so that callers (and
      // tests) observe a terminal completed_unresolved state even if no
      // slice was running locally — e.g. paused workflows or workflows
      // resumed across process restarts.
      const existingSnapshot =
        envelope.featureSnapshot &&
        typeof envelope.featureSnapshot === "object" &&
        !Array.isArray(envelope.featureSnapshot)
          ? (envelope.featureSnapshot as Record<string, unknown>)
          : {};
      const nextSnapshot: Record<string, unknown> = { ...existingSnapshot };
      nextSnapshot["status"] = "completed_unresolved";
      nextSnapshot["unresolvedReason"] = "user_stopped";
      const completedRounds = extractCompletedRounds(nextSnapshot);

      await repo.update(input.workflowId, {
        status: "completed",
        phase: "asymmetric_user_stopped",
        errorSummary: "Run stopped by user before convergence",
        featureSnapshot: nextSnapshot,
        ...(envelope.pause !== undefined ? { pause: undefined } : {}),
      });

      try {
        deps.publishStatus({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          workflowId: input.workflowId,
          status: "completed",
          timestamp: deps.now(),
          reason: "user_stopped",
          payload: {
            kind: "completed_unresolved",
            reason: "user_stopped",
            negotiationRoundsCompleted: completedRounds,
          },
        });
      } catch (err) {
        logger.warn("collaboration.manager.stop_status_publish_failed", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          workflowId: input.workflowId,
          error: getErrorMessage(err),
        });
      }

      if (!signaled) {
        try {
          deps.dispatchPush({
            kind: "completed-unresolved",
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            reason: "user_stopped",
          });
        } catch (err) {
          logger.warn("collaboration.manager.stop_push_dispatch_failed", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            error: getErrorMessage(err),
          });
        }
      }

      logger.info("collaboration.manager.stop", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId: input.workflowId,
        conversationId: parsed.conversationId,
        signaledRunningSlice: signaled,
        directTerminalPushDispatched: !signaled,
      });

      return { workflowId: input.workflowId, status: "stopped" as const };
    },

    async getEnvelope(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      return repo.get(input.workflowId);
    },

    async listActive(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listActive();
      return all.filter((env) => env.workflowType === "collaboration");
    },

    async listAll(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listAll();
      return all.filter((env) => env.workflowType === "collaboration");
    },
  };
}

let cachedManager: CollaborationManager | null = null;

export function getDefaultCollaborationManager(): CollaborationManager {
  if (!cachedManager) {
    cachedManager = createCollaborationManager();
  }
  return cachedManager;
}
