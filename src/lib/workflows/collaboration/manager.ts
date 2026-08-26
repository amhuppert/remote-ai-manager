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
  getAbortHandle,
  registerAbortHandle,
  releaseAbortHandle,
  type AbortHandleKey,
} from "@/lib/shared/abort-registry";
import {
  runAsymmetricCollaborationSlice,
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
  type AsymmetricCollaborationSliceResult,
  type AsymmetricDispatchInfo,
} from "./envelope";
import { createCollaborationDeps } from "./deps-factory";
import {
  createCollaborationProductionCallAgent,
  type CollaborationLaneAgentConfig,
  type CollaborationLaneAgentsInput,
  type CollaborationProductionAgentCallerInput,
} from "./agent-caller-production";
import { oppositeCollaborationBackend } from "./backend-pair";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import {
  failedSessionContextSource,
  parseSessionContextForExecution,
  resolveCollaborationSessionContext,
  type CollaborationSessionContext,
  type CollaborationSessionContextCapture,
} from "./session-context";
import { isAlignmentEligibleContext } from "@/lib/workflows/conversation/pre-turn/alignment-gate";
import { getSessionAlignmentServiceForProduction } from "@/lib/session-alignment/service-factory";
import type {
  CaptureActiveCharterInput,
  CapturedAlignmentCharter,
} from "@/lib/session-alignment/service";
import { getLiveTicketContextProvider } from "@/lib/tickets/service-factory";
import type { SessionState } from "@/lib/sessions/schemas";
import { createSessionWorkflowEnvelopeRepositoryForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeRepository } from "@/lib/workflows/primitives/workflow-envelope-repository";
import {
  createLaneService,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import {
  getSession as defaultGetSession,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  resolveConfiguredAgentBackendDefaults,
  type ConversationTurnConfig,
} from "@/lib/agent-backends/conversation-policy";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";
import {
  getNextImageIndex,
  saveWorkflowTranscriptImage,
} from "@/lib/images/transcript-images";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  collaborationAgentSchema,
  collaborationAgentTwoRequestSchema,
  collaborationAgentsMapSchema,
  collaborationArtifactSchema,
  collaborationAutonomousResolutionThresholdSchema,
  isCollaborationAgent,
  type CollaborationAgent,
  type CollaborationAgentsMap,
  type CollaborationArtifact,
  type CollaborationResolvedAgent,
} from "./types";
import {
  readCollaborationArtifacts,
  readCollaborationArtifactStream,
  type CollaborationArtifactStreamRead,
} from "./artifacts-store";
import { buildCollaborationStepLedger } from "./step-ledger";
import { collaborationFailureCauseSchema } from "./failure-cause";
import {
  decideResumeEligibility,
  describeResumeRefusal,
  type ResumeRefusal,
} from "./resume-eligibility";
import {
  reclaimConversationOwnership,
  releaseConversationOwnership,
  type OwnershipReclaimDecision,
} from "@/lib/conversations/ownership";
import { dispatchPushForCollaborationEvent } from "@/lib/push-notification/dispatcher";
import {
  publishScopedStatus,
  type PublishScopedStatusInput,
} from "@/lib/events/publication";
import { assembleUserContentBlocks } from "@/lib/workflows/conversation/assemble-user-blocks";
import {
  appendTranscriptEntryOnce,
  getTranscriptPath,
  type TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import { buildCollaborationUserTranscriptEntry } from "./transcript";

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

/**
 * The attempt a fresh run is its first. Every claim increments from here, so an
 * epoch is both the attempt count and the fence a superseded attempt fails.
 */
export const COLLABORATION_INITIAL_ATTEMPT_EPOCH = 1;

export const collaborationStartRequestSchema = z
  .object({
    brief: z.string().trim().min(1, "brief is required"),
    negotiationRounds: z.number().int().min(1).max(20),
    autonomousResolutionThreshold:
      collaborationAutonomousResolutionThresholdSchema,
    conversationId: z.string().trim().min(1, "conversationId is required"),
    // The route handler adopts the selected backend onto the conversation
    // before the manager derives Agent One. It remains optional when the
    // stored conversation backend is authoritative.
    backend: agentBackendSchema.optional(),
    // Present replaces Agent One's configured selection as one whole value.
    modelSelection: backendModelSelectionSchema.optional(),
    modelId: z.never().optional(),
    effort: z.never().optional(),
    codexFastMode: z.never().optional(),
    // Agent Two defaults to the opposite backend and its configured selection.
    agentTwo: collaborationAgentTwoRequestSchema.optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
  })
  .strict();
type CollaborationStartRequest = z.infer<
  typeof collaborationStartRequestSchema
>;

export const collaborationResumeRequestSchema = z.object({
  /**
   * Required only for a PAUSED run, where it binds a set of answers to the
   * exact question set that produced them. A failed run carries no answers, so
   * there is nothing to bind — the attempt epoch fences that path instead. The
   * status-specific requirement is enforced in `resume`, which is the only
   * place that knows which status it is looking at.
   */
  resumeToken: z.string().trim().min(1).optional(),
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
  /**
   * Decides Alignment eligibility for the run: only a normal session's
   * user-invoked collaboration is governed by a charter.
   */
  creationMode?: SessionState["creationMode"] | undefined;
}

interface CollaborationManagerConversationResolution {
  agentBackend: AgentBackendId;
  promptCount: number;
  /**
   * The conversation's stored backend session ref. The manager forwards
   * this onto the slice as `priorBackendRef` so Agent One's first turn can
   * resume the originating conversation's backend session.
   */
  backendRef?: AgentSessionRef | null;
  /**
   * The conversation's stored agent-profile snapshot. Agent One's lane
   * inherits it VERBATIM (fork-inherits-snapshot semantics) — the manager
   * never re-resolves it, so library edits after the conversation was staffed
   * cannot change who Agent One collaborates as. `null` for legacy
   * conversations that predate profiles.
   */
  profileSnapshot?: AgentProfileSnapshot | null;
}

interface CollaborationStartPersistenceInput {
  projectPath: string;
  sessionName: string;
  workflowId: string;
  conversationId: string;
  expectedPromptCount: number;
  brief: string;
  imageRefs: readonly ConversationImageRef[];
  modelSelection: BackendModelSelection;
}

interface CollaborationStartPersisterDeps {
  getTranscriptPath(conversationId: string): Promise<string>;
  appendTranscriptEntryOnce(
    conversationId: string,
    entry: ReturnType<typeof buildCollaborationUserTranscriptEntry> & {
      id: string;
    },
    projectContext?: TranscriptBroadcastMeta,
  ): Promise<void>;
  mutateConversation<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  now(): string;
}

export class CollaborationStartConflictError extends Error {
  constructor(public readonly conversationId: string) {
    super(
      `Conversation "${conversationId}" is no longer idle for this collaboration start`,
    );
    this.name = "CollaborationStartConflictError";
  }
}

export interface CollaborationStartClaim {
  /** The conversation's turn generation AFTER this claim. A resume compares
   *  the record against this to prove no other turn intervened. */
  claimedTurnGeneration: number;
}

export function createCollaborationStartPersister(
  deps: CollaborationStartPersisterDeps,
): (
  input: CollaborationStartPersistenceInput,
) => Promise<CollaborationStartClaim> {
  return async (input) => {
    const transcriptPath = await deps.getTranscriptPath(input.conversationId);
    const timestamp = deps.now();
    const priorState = await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "collab.start.claim",
      (conversation) => {
        const isIdle =
          conversation.status === "new" || conversation.status === "awaiting";
        if (
          conversation.promptCount !== input.expectedPromptCount ||
          !isIdle ||
          conversation.owner !== null
        ) {
          throw new CollaborationStartConflictError(input.conversationId);
        }
        const prior = {
          promptCount: conversation.promptCount,
          status: conversation.status,
          transcriptPath: conversation.transcriptPath,
          lastActivityAt: conversation.lastActivityAt,
          turnGeneration: conversation.turnGeneration,
          owner: conversation.owner,
        };
        conversation.promptCount += 1;
        conversation.status = "running";
        if (conversation.transcriptPath === null) {
          conversation.transcriptPath = transcriptPath;
        }
        conversation.lastActivityAt = timestamp;
        // Claiming and admitting are the same act for a collaboration: it takes
        // the conversation AND occupies its next turn. Both land here so a
        // prompt cannot slip between them.
        conversation.turnGeneration += 1;
        conversation.owner = {
          kind: "collaboration",
          workflowId: input.workflowId,
          attemptEpoch: COLLABORATION_INITIAL_ATTEMPT_EPOCH,
        };
        return prior;
      },
    );

    try {
      await deps.appendTranscriptEntryOnce(
        input.conversationId,
        buildCollaborationUserTranscriptEntry({
          id: `collab-start:${input.workflowId}`,
          timestamp,
          brief: input.brief,
          imageRefs: input.imageRefs,
          modelSelection: input.modelSelection,
        }) as ReturnType<typeof buildCollaborationUserTranscriptEntry> & {
          id: string;
        },
        {
          projectName: path.basename(input.projectPath),
          storeSessionName: input.sessionName,
        },
      );
    } catch (error) {
      try {
        await deps.mutateConversation(
          input.projectPath,
          input.sessionName,
          input.conversationId,
          "collab.start.compensate",
          (conversation) => {
            const claimStillOwned =
              conversation.promptCount === input.expectedPromptCount + 1 &&
              conversation.status === "running";
            if (!claimStillOwned) {
              logger.error("collaboration.manager.start_compensation_skipped", {
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                workflowId: input.workflowId,
                conversationId: input.conversationId,
                promptCount: conversation.promptCount,
                status: conversation.status,
              });
              return;
            }
            conversation.promptCount = priorState.promptCount;
            conversation.status = priorState.status;
            conversation.transcriptPath = priorState.transcriptPath;
            conversation.lastActivityAt = priorState.lastActivityAt;
            conversation.turnGeneration = priorState.turnGeneration;
            conversation.owner = priorState.owner;
          },
        );
      } catch (compensationError) {
        logger.error("collaboration.manager.start_compensation_failed", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          workflowId: input.workflowId,
          conversationId: input.conversationId,
          error: getErrorMessage(compensationError),
        });
      }
      throw error;
    }

    logger.info("collaboration.manager.start_persisted", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      imageCount: input.imageRefs.length,
      claimedTurnGeneration: priorState.turnGeneration + 1,
    });
    return { claimedTurnGeneration: priorState.turnGeneration + 1 };
  };
}

export async function prepareCollaborationInitialImages(
  input: {
    conversationId: string;
    workflowId: string;
    brief: string;
    images: readonly ImagePayload[];
  },
  configDir?: string,
): Promise<{ brief: string; imageRefs: ConversationImageRef[] }> {
  const startIndex = await getNextImageIndex(input.conversationId, configDir);
  const assembled = assembleUserContentBlocks({
    promptText: input.brief,
    images: input.images,
    startIndex,
  });
  const imagesById = new Map(
    input.images.map((image) => [image.attachmentId, image]),
  );
  const refs: ConversationImageRef[] = [];
  for (const assignment of assembled.assignments) {
    const image = imagesById.get(assignment.attachmentId);
    if (!image) continue;
    const path = await saveWorkflowTranscriptImage(
      input.conversationId,
      input.workflowId,
      assignment.serverIndex,
      image.mediaType,
      image.base64Data,
      configDir,
    );
    refs.push({
      index: assignment.serverIndex,
      mediaType: image.mediaType,
      path,
      base64Data: image.base64Data,
    });
  }
  logger.debug("collaboration.manager.initial_images_prepared", {
    conversationId: input.conversationId,
    imageCount: refs.length,
    startIndex,
  });
  return { brief: assembled.rewrittenPromptText, imageRefs: refs };
}

export interface CollaborationBackendRuntimeConfig {
  modelSelection: BackendModelSelection;
  timeoutMs: number;
  stallTimeoutMs: number;
}

/**
 * Scope of one capture. `worktreePath` is load-bearing: a digest-mode charter
 * is frozen at a hash-addressed path inside the run's own worktree, so the
 * pointer the run stores cannot be repointed by a later activation.
 */
export interface CollaborationSessionContextResolutionInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  creationMode: SessionState["creationMode"] | undefined;
  workflowId: string;
  conversationId: string;
}

export interface CollaborationSessionContextSources {
  captureActiveCharterForRun(
    input: CaptureActiveCharterInput,
  ): Promise<CapturedAlignmentCharter | null>;
  getLiveTicketBlock(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
}

/**
 * Runs one capture and records its outcome as metadata: presence, eligibility,
 * version, hash, and sizes. Never the charter text, the ticket block, or the
 * charter's snapshot path — a log line must stay safe to hand to anyone who
 * can read logs but not the session.
 */
async function captureSessionContextForStart(
  input: CollaborationSessionContextResolutionInput & {
    resolve: CollaborationManagerDeps["resolveSessionContext"];
  },
): Promise<CollaborationSessionContext> {
  const { resolve, ...scope } = input;
  const startedAt = performance.now();
  const eligible = isAlignmentEligibleContext({
    kind: "standalone_collaboration",
    creationMode: scope.creationMode,
    userInitiated: true,
  });

  let capture: CollaborationSessionContextCapture;
  try {
    capture = await resolve(scope);
  } catch (error) {
    logger.error("collaboration.manager.session_context_resolution_failed", {
      projectPath: scope.projectPath,
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
      workflowId: scope.workflowId,
      eligible,
      failedSource: failedSessionContextSource(error),
      fatal: true,
      durationMs: performance.now() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }

  const context = capture.context;
  // A source that failed without aborting the run still gets attributed, or an
  // operator cannot tell an unreadable ticket from a session that has none.
  if (capture.degraded) {
    logger.warn("collaboration.manager.session_context_resolution_failed", {
      projectPath: scope.projectPath,
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
      workflowId: scope.workflowId,
      eligible,
      failedSource: capture.degraded.source,
      fatal: false,
      durationMs: performance.now() - startedAt,
      error: capture.degraded.error,
    });
  }

  logger.info("collaboration.manager.session_context_resolved", {
    projectPath: scope.projectPath,
    sessionName: scope.sessionName,
    conversationId: scope.conversationId,
    workflowId: scope.workflowId,
    alignmentPresent: context.alignment !== null,
    eligible,
    alignmentVersion: context.alignment?.version ?? null,
    alignmentContentHash: context.alignment?.contentHash ?? null,
    activeTicketPresent: context.activeTicketBlock !== null,
    alignmentChars: context.alignment?.text.length ?? 0,
    ticketBlockChars: context.activeTicketBlock?.length ?? 0,
    durationMs: performance.now() - startedAt,
  });
  return context;
}

/**
 * Adapts the two canonical context owners to the manager's capture dep. Both
 * values are taken verbatim from their owners — neither is re-rendered here.
 */
export function createCollaborationSessionContextResolver(
  sources: CollaborationSessionContextSources,
): CollaborationManagerDeps["resolveSessionContext"] {
  return (input) =>
    resolveCollaborationSessionContext(
      {
        captureActiveCharter: (projectPath, sessionName) =>
          sources.captureActiveCharterForRun({
            projectPath,
            sessionName,
            worktreePath: input.worktreePath,
          }),
        getLiveTicketBlock: (projectPath, sessionName) =>
          sources.getLiveTicketBlock(projectPath, sessionName),
      },
      {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        creationMode: input.creationMode,
      },
    );
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
   * Captures the run's governing session context — the active Alignment
   * charter and the linked ticket's `<active-ticket>` block — once, before the
   * conversation is claimed. A rejection is fatal to the start: the charter
   * governs both lanes, so running without it silently is the failure mode
   * worth preventing. A source that failed without aborting the capture comes
   * back as `degraded` so the manager can attribute it.
   */
  resolveSessionContext(
    input: CollaborationSessionContextResolutionInput,
  ): Promise<CollaborationSessionContextCapture>;

  prepareInitialImages(input: {
    conversationId: string;
    workflowId: string;
    brief: string;
    images: readonly ImagePayload[];
  }): Promise<{ brief: string; imageRefs: ConversationImageRef[] }>;

  persistStart(input: {
    projectPath: string;
    sessionName: string;
    workflowId: string;
    conversationId: string;
    expectedPromptCount: number;
    brief: string;
    imageRefs: readonly ConversationImageRef[];
    modelSelection: BackendModelSelection;
  }): Promise<CollaborationStartClaim>;

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
    agents: CollaborationLaneAgentsInput;
  }): AsymmetricCollaborationSliceDeps["callAgent"];

  /**
   * Validates a lane's complete selection against the configured catalog and
   * project policy before anything durable happens, mirroring the prompt
   * path's pre-execution gate. Tests inject a deterministic implementation.
   */
  admitModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection: BackendModelSelection;
  }): BackendModelSelection | Promise<BackendModelSelection>;

  /**
   * Resolves Agent Two's profile selection (or the Standard Agent default)
   * into the snapshot the envelope persists, BEFORE anything durable happens.
   * Fails closed on an unknown, deleted, or quarantined reference — a run
   * staffed under a profile nobody selected would carry a false record.
   * Defaults to `resolveConversationProfileSnapshot`, the shared resolution
   * entry point every creation surface uses.
   */
  resolveAgentTwoProfileSnapshot(input: {
    projectPath: string;
    ref: AgentProfileRef | null;
  }): Promise<AgentProfileSnapshot>;

  /**
   * Resolves the Codex lane's independent runtime profile from global config.
   * Standalone Collaboration mode carries no per-call settings, so these
   * defaults must cross the manager boundary together. Defaults to reading the
   * singleton global config; tests inject a deterministic value.
   */
  resolveCodexModelConfig(): Promise<CollaborationBackendRuntimeConfig>;

  /**
   * Resolves the Claude lane's independent runtime profile from global config.
   * The manager carries it alongside the Codex profile without requiring
   * either backend to be selected as the conversation default.
   */
  resolveClaudeModelConfig(): Promise<CollaborationBackendRuntimeConfig>;

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

  /**
   * Reads a workflow's artifact stream back from its durable JSONL sidecar so
   * `getEnvelope`/`listActive`/`listAll` can re-inject it into the envelope's
   * `featureSnapshot.artifacts`, keeping the client-visible response shape
   * unchanged. The sidecar is the durable store; the blob carries only bounded
   * lifecycle/config state. Defaults to the production
   * `readCollaborationArtifacts`; tests inject a deterministic reader.
   */
  readArtifacts(workflowId: string): Promise<CollaborationArtifact[]>;
  /** The STRICT read resume decides from — absence, I/O failure and skipped
   *  lines kept apart, because "nothing recorded" and "could not read" must
   *  not both mean "start over". */
  readArtifactStream(
    workflowId: string,
  ): Promise<CollaborationArtifactStreamRead<CollaborationArtifact>>;
  /** Hands the originating conversation back, fenced on the exact attempt.
   *  Stop needs its own path to this: a paused run has no live slice to do it,
   *  and an owner nothing ever clears locks the user out of the conversation. */
  releaseConversationOwner(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    owner: { kind: "collaboration"; workflowId: string; attemptEpoch: number };
  }): Promise<boolean>;
  /** Takes the originating conversation back for a new attempt, refusing when
   *  another turn has been admitted since this run claimed it. */
  reclaimConversationOwner(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    owner: { kind: "collaboration"; workflowId: string; attemptEpoch: number };
    request: { workflowId: string; claimedTurnGeneration: number };
  }): Promise<OwnershipReclaimDecision>;

  publishStatus(
    input: Omit<
      PublishScopedStatusInput,
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

/**
 * Production stop registry over the shared abort registry
 * (`@/lib/shared/abort-registry`, scope `workflow:*`). Signalling retains the
 * aborted handle — the running slice observes `signalFor` between rounds and
 * would miss the stop if the entry were removed on abort — so removal happens
 * only through `release` at slice teardown.
 */
export function createSharedCollaborationStopRegistry(): CollaborationStopRegistry {
  const keyFor = (workflowId: string): AbortHandleKey =>
    `workflow:${workflowId}`;
  return {
    register(workflowId) {
      const controller = new AbortController();
      registerAbortHandle(keyFor(workflowId), controller);
      return controller;
    },
    signal(workflowId) {
      const controller = getAbortHandle(keyFor(workflowId));
      if (!controller) return false;
      if (!controller.signal.aborted) controller.abort();
      return true;
    },
    signalFor(workflowId) {
      return getAbortHandle(keyFor(workflowId))?.signal ?? null;
    },
    release(workflowId) {
      releaseAbortHandle(keyFor(workflowId));
    },
  };
}

const defaultStopRegistry = createSharedCollaborationStopRegistry();

/**
 * Maps a standalone collaboration run's manager facts onto the production
 * agent-caller composition. Extracted so the standalone-only decisions it
 * encodes — notably the CC session-scope grant, which no other collaboration
 * entry point may make — are assertable without booting real backends.
 */
export function buildStandaloneCollaborationCallerInput(
  input: Parameters<CollaborationManagerDeps["buildCallAgent"]>[0],
): CollaborationProductionAgentCallerInput {
  return {
    workflowId: input.workflowId,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    sessionKey: `${input.projectPath}::${input.sessionName}`,
    originatingConversationId: input.conversationId,
    // Standalone collaboration is one attended logical turn owned by the
    // originating conversation, so its Codex task lane may act as that
    // session and run the captured ticket block's `cctl` retrieval commands.
    grantsOriginatingSessionScope: true,
    laneService: input.laneService,
    agents: input.agents,
  };
}

const defaultBuildCallAgent: CollaborationManagerDeps["buildCallAgent"] = (
  input,
) =>
  createCollaborationProductionCallAgent(
    buildStandaloneCollaborationCallerInput(input),
  );

const defaultAdmitModelSelection: CollaborationManagerDeps["admitModelSelection"] =
  async (input) => {
    const admission = await admitConfiguredModelSelection(input);
    if (!admission.ok) {
      throw new Error(admission.message);
    }
    return admission.modelSelection;
  };

const defaultResolveAgentTwoProfileSnapshot: CollaborationManagerDeps["resolveAgentTwoProfileSnapshot"] =
  (input) => resolveConversationProfileSnapshot(input.projectPath, input.ref);

export function resolveCollaborationBackendModelConfig(
  config: ConversationTurnConfig,
  backend: AgentBackendId,
): CollaborationBackendRuntimeConfig {
  const resolved = resolveConfiguredAgentBackendDefaults(config, backend);
  return {
    modelSelection: resolved.modelSelection,
    timeoutMs: resolved.timeoutMs,
    stallTimeoutMs: resolved.stallTimeoutMs,
  };
}

function resolveRuntimeConfigFor(
  deps: CollaborationManagerDeps,
  backend: CollaborationAgent,
): Promise<CollaborationBackendRuntimeConfig> {
  // A selection map keyed by collaboration agent, not an identity branch: the
  // two config resolvers are the manager's per-provider dependency surface, and
  // the key type is exactly the set of backends the flow runs.
  const resolvers: Record<
    CollaborationAgent,
    () => Promise<CollaborationBackendRuntimeConfig>
  > = {
    codex: () => deps.resolveCodexModelConfig(),
    claude: () => deps.resolveClaudeModelConfig(),
  };
  return resolvers[backend]();
}

/**
 * A lane agent's caller-input shape: the persisted resolved identity plus the
 * config-derived runtime bounds (timeouts), which are never persisted.
 */
function laneAgentInput(
  resolved: CollaborationResolvedAgent,
  runtime: CollaborationBackendRuntimeConfig,
): CollaborationLaneAgentConfig {
  return {
    backend: resolved.backend,
    modelSelection: resolved.modelSelection,
    timeoutMs: runtime.timeoutMs,
    stallTimeoutMs: runtime.stallTimeoutMs,
  };
}

const defaultDeps: CollaborationManagerDeps = {
  async resolveSession(input) {
    const session = await defaultGetSession(
      input.projectPath,
      input.sessionName,
    );
    if (!session) return null;
    return {
      worktreePath: session.worktreePath,
      creationMode: session.creationMode,
    };
  },
  async resolveConversation(input) {
    const conv = await defaultGetConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    if (!conv) return null;
    return {
      agentBackend: conv.agentBackend,
      backendRef: conv.backendRef,
      promptCount: conv.promptCount ?? 0,
      profileSnapshot: conv.profileSnapshot ?? null,
    };
  },
  resolveSessionContext: createCollaborationSessionContextResolver({
    captureActiveCharterForRun: (input) =>
      getSessionAlignmentServiceForProduction().captureActiveCharterForRun(
        input,
      ),
    getLiveTicketBlock: (projectPath, sessionName) =>
      getLiveTicketContextProvider().getForSession(projectPath, sessionName),
  }),
  prepareInitialImages: prepareCollaborationInitialImages,
  persistStart: createCollaborationStartPersister({
    getTranscriptPath,
    appendTranscriptEntryOnce: (conversationId, entry, projectContext) =>
      appendTranscriptEntryOnce(
        conversationId,
        entry,
        undefined,
        projectContext,
      ),
    mutateConversation: defaultMutateConversation,
    now: () => new Date().toISOString(),
  }),
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
  admitModelSelection: defaultAdmitModelSelection,
  resolveAgentTwoProfileSnapshot: defaultResolveAgentTwoProfileSnapshot,
  async resolveCodexModelConfig() {
    const config = await defaultReadConfig();
    return resolveCollaborationBackendModelConfig(config, "codex");
  },
  async resolveClaudeModelConfig() {
    const config = await defaultReadConfig();
    return resolveCollaborationBackendModelConfig(config, "claude");
  },
  runSlice: runAsymmetricCollaborationSlice,
  createEnvelopeRepository(input) {
    return createSessionWorkflowEnvelopeRepositoryForProduction({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
  },
  readArtifactStream(workflowId) {
    return readCollaborationArtifactStream(
      workflowId,
      collaborationArtifactSchema,
    );
  },
  releaseConversationOwner({
    projectPath,
    sessionName,
    conversationId,
    owner,
  }) {
    return releaseConversationOwnership(
      defaultMutateConversation,
      { projectPath, storeSessionName: sessionName, conversationId },
      owner,
    );
  },
  reclaimConversationOwner({
    projectPath,
    sessionName,
    conversationId,
    owner,
    request,
  }) {
    return reclaimConversationOwnership(
      defaultMutateConversation,
      { projectPath, storeSessionName: sessionName, conversationId },
      owner,
      request,
    );
  },
  readArtifacts(workflowId) {
    return readCollaborationArtifacts(workflowId, collaborationArtifactSchema);
  },
  publishStatus(input) {
    const projectName = path.basename(input.projectPath);
    const outcome = publishScopedStatus({
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

export class CollaborationNotResumableError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly status: string,
  ) {
    super(
      `Workflow "${workflowId}" is not resumable (status=${status}); resume is valid for paused or failed workflows`,
    );
    this.name = "CollaborationNotResumableError";
  }
}

/** A failed run the eligibility gates refused, with the user-facing reason. */
export class CollaborationResumeRefusedError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly refusal: ResumeRefusal,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationResumeRefusedError";
  }
}

/** The conversation is no longer the one this collaboration claimed. */
export class CollaborationConversationOwnershipError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly reason: string,
    detail: string,
  ) {
    super(detail);
    this.name = "CollaborationConversationOwnershipError";
  }
}

export class CollaborationProfileResolutionError extends Error {
  constructor(
    public readonly ref: AgentProfileRef | null,
    reason: string,
  ) {
    super(
      `Failed to resolve Agent Two's profile${ref ? ` ${ref.tier}:${ref.id}` : ""}: ${reason}`,
    );
    this.name = "CollaborationProfileResolutionError";
  }
}

export class CollaborationModelSelectionValidationError extends Error {
  constructor(
    public readonly agent: "agent_one" | "agent_two",
    public readonly backend: AgentBackendId,
    public readonly modelSelection: BackendModelSelection,
    reason: string,
  ) {
    super(
      `Invalid model selection for ${agent} (${backend} ${modelSelection.modelId}): ${reason}`,
    );
    this.name = "CollaborationModelSelectionValidationError";
  }
}

/**
 * A registered backend that Collaboration Mode does not run was asked to take a
 * lane. Bounded and named rather than substituted: silently swapping in an
 * eligible backend would run a flow the caller did not ask for, and letting the
 * ineligible one through would dispatch a lane whose contracts were never
 * evidenced for it. Thrown before anything durable happens.
 */
export class CollaborationBackendNotEligibleError extends Error {
  constructor(
    public readonly agent: "agent_one" | "agent_two",
    public readonly backend: AgentBackendId,
  ) {
    super(
      `Backend "${backend}" cannot take the ${agent} lane: Collaboration Mode runs ${collaborationAgentSchema.options.join(" and ")}.`,
    );
    this.name = "CollaborationBackendNotEligibleError";
  }
}

function requireCollaborationAgent(
  agent: "agent_one" | "agent_two",
  backend: AgentBackendId,
): CollaborationAgent {
  if (!isCollaborationAgent(backend)) {
    throw new CollaborationBackendNotEligibleError(agent, backend);
  }
  return backend;
}

async function admitCollaborationAgentSelections(
  deps: Pick<CollaborationManagerDeps, "admitModelSelection">,
  projectPath: string,
  agents: CollaborationAgentsMap,
): Promise<CollaborationAgentsMap> {
  const canonicalAgents = structuredClone(agents);
  for (const agent of ["agent_one", "agent_two"] as const) {
    const resolved = canonicalAgents[agent];
    try {
      resolved.modelSelection = await deps.admitModelSelection({
        backend: resolved.backend,
        projectPath,
        modelSelection: resolved.modelSelection,
      });
    } catch (err) {
      throw new CollaborationModelSelectionValidationError(
        agent,
        resolved.backend,
        resolved.modelSelection,
        getErrorMessage(err),
      );
    }
  }
  return canonicalAgents;
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
        modelSelection: input.modelSelection,
        agentTwo: input.agentTwo,
        images: input.images,
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

      const workflowId = deps.newWorkflowId();

      // Capture the run's premises before anything durable happens: a charter
      // failure must leave the conversation unclaimed, with no prompt-count
      // change, no registered stop handle, and no lane dispatched.
      const sessionContext = await captureSessionContextForStart({
        resolve: deps.resolveSessionContext,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        creationMode: session.creationMode,
        workflowId,
        conversationId: parsed.conversationId,
      });

      // Agent Two's profile resolves fail-closed BEFORE anything durable
      // (images, transcript entry, envelope): an unknown reference must leave
      // the conversation unclaimed. The Standard Agent default resolves like
      // any other selection, so the persisted record always names who Agent
      // Two ran as.
      let agentTwoProfileSnapshot: AgentProfileSnapshot;
      try {
        agentTwoProfileSnapshot = await deps.resolveAgentTwoProfileSnapshot({
          projectPath: input.projectPath,
          ref: parsed.agentTwo?.profile ?? null,
        });
      } catch (err) {
        throw new CollaborationProfileResolutionError(
          parsed.agentTwo?.profile ?? null,
          getErrorMessage(err),
        );
      }

      const preparedImages = parsed.images?.length
        ? await deps.prepareInitialImages({
            conversationId: parsed.conversationId,
            workflowId,
            brief: parsed.brief,
            images: parsed.images,
          })
        : { brief: parsed.brief, imageRefs: [] };
      const { brief, imageRefs } = preparedImages;

      // Fail closed before anything durable: a conversation on a backend
      // Collaboration Mode does not run cannot take Agent One's lane.
      const primaryAgentBackend = requireCollaborationAgent(
        "agent_one",
        conversation.agentBackend,
      );

      const sessionKey = `${input.projectPath}::${input.sessionName}`;

      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });

      const agentOneRuntime = await resolveRuntimeConfigFor(
        deps,
        primaryAgentBackend,
      );
      const agentOneModelSelection =
        parsed.modelSelection ?? agentOneRuntime.modelSelection;

      // Agent Two resolves explicit request config → global config default
      // for its backend → catalog default. Its backend defaults to the
      // opposite of Agent One's, but an explicit choice — including the same
      // backend — always wins.
      const agentTwoBackend: CollaborationAgent =
        parsed.agentTwo?.backend === undefined
          ? oppositeCollaborationBackend(primaryAgentBackend)
          : requireCollaborationAgent("agent_two", parsed.agentTwo.backend);
      const agentTwoRuntime = await resolveRuntimeConfigFor(
        deps,
        agentTwoBackend,
      );
      const agentTwoModelSelection =
        parsed.agentTwo?.modelSelection ?? agentTwoRuntime.modelSelection;

      const requestedAgents: CollaborationAgentsMap = {
        agent_one: {
          backend: primaryAgentBackend,
          modelSelection: agentOneModelSelection,
          // Verbatim inheritance of the conversation's staffing; a legacy
          // conversation with no snapshot collaborates profile-less as before.
          ...(conversation.profileSnapshot != null
            ? { profileSnapshot: conversation.profileSnapshot }
            : {}),
        },
        agent_two: {
          backend: agentTwoBackend,
          modelSelection: agentTwoModelSelection,
          profileSnapshot: agentTwoProfileSnapshot,
        },
      };

      // Both lanes gate on exact complete catalog variants before anything
      // durable happens, mirroring the prompt path.
      const agents = await admitCollaborationAgentSelections(
        deps,
        input.projectPath,
        requestedAgents,
      );

      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId,
        conversationId: parsed.conversationId,
        laneService,
        agents: {
          agent_one: laneAgentInput(agents.agent_one, agentOneRuntime),
          agent_two: laneAgentInput(agents.agent_two, agentTwoRuntime),
        },
      });

      const sliceDeps = deps.createDeps({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        callAgent,
        laneService,
      });

      const stopController = deps.stopRegistry.register(workflowId);

      let startClaim: CollaborationStartClaim;
      try {
        startClaim = await deps.persistStart({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          workflowId,
          conversationId: parsed.conversationId,
          expectedPromptCount: conversation.promptCount,
          brief,
          imageRefs,
          modelSelection: agents.agent_one.modelSelection,
        });
      } catch (error) {
        deps.stopRegistry.release(workflowId);
        throw error;
      }

      // Built after the claim so the run records the generation it actually
      // took, not one read before another turn could have been admitted.
      const sliceInput: AsymmetricCollaborationSliceInput = {
        workflowId,
        brief,
        worktreePath: session.worktreePath,
        sessionKey,
        primaryAgentBackend,
        agents,
        negotiationRounds: parsed.negotiationRounds,
        autonomousResolutionThreshold: parsed.autonomousResolutionThreshold,
        sessionContext,
        conversationId: parsed.conversationId,
        priorBackendRef: conversation.backendRef ?? undefined,
        imageRefs,
        stopSignal: stopController.signal,
        attemptEpoch: COLLABORATION_INITIAL_ATTEMPT_EPOCH,
        claimedTurnGeneration: startClaim.claimedTurnGeneration,
      };

      logger.info("collaboration.manager.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId,
        negotiationRounds: parsed.negotiationRounds,
        autonomousResolutionThreshold: parsed.autonomousResolutionThreshold,
        primaryAgentBackend,
        requestModelSelection: parsed.modelSelection ?? null,
        requestAgentTwoBackend: parsed.agentTwo?.backend ?? null,
        agentOneBackend: agents.agent_one.backend,
        agentOneModelSelection: agents.agent_one.modelSelection,
        agentTwoBackend: agents.agent_two.backend,
        agentTwoModelSelection: agents.agent_two.modelSelection,
        // Profile identity only — instruction contents never reach the log.
        agentTwoProfile: `${agentTwoProfileSnapshot.tier}:${agentTwoProfileSnapshot.id}`,
        agentTwoProfileRevision: agentTwoProfileSnapshot.revision,
        agentTwoProfileHash: agentTwoProfileSnapshot.resolvedInstructionHash,
        agentOneProfile: conversation.profileSnapshot
          ? `${conversation.profileSnapshot.tier}:${conversation.profileSnapshot.id}`
          : null,
        conversationId: parsed.conversationId,
        priorBackendRefBackend: conversation.backendRef?.backend ?? null,
        imageCount: imageRefs.length,
        alignmentVersion: sessionContext.alignment?.version ?? null,
        activeTicketPresent: sessionContext.activeTicketBlock !== null,
      });

      void Promise.resolve()
        .then(() => deps.runSlice(sliceInput, sliceDeps))
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
      const resumingFailure = envelope.status === "failed";
      if (envelope.status !== "paused" && !resumingFailure) {
        throw new CollaborationNotResumableError(
          input.workflowId,
          envelope.status,
        );
      }
      // The pause token binds a set of answers to the specific question set
      // that produced them. A failure resume carries no answers, so there is
      // nothing to bind — the attempt epoch is what fences it instead.
      if (
        !resumingFailure &&
        envelope.pause?.resumeToken !== parsed.resumeToken
      ) {
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
      const primaryBackendParse = collaborationAgentSchema.safeParse(
        existingSnapshot["primaryAgentBackend"],
      );
      const primaryAgentBackend: CollaborationAgent =
        primaryBackendParse.success ? primaryBackendParse.data : "claude";
      const autonomousResolutionThreshold =
        collaborationAutonomousResolutionThresholdSchema.safeParse(
          existingSnapshot["autonomousResolutionThreshold"],
        );
      const conversationId = parsed.conversationId;
      const completedRounds = extractCompletedRounds(existingSnapshot);
      const persistedAgentsParse = collaborationAgentsMapSchema.safeParse(
        existingSnapshot["agents"],
      );
      if (!resumingFailure && !persistedAgentsParse.success) {
        const refusal: ResumeRefusal = {
          code: "premise_missing",
          detail: "agents",
        };
        throw new CollaborationResumeRefusedError(
          input.workflowId,
          refusal,
          describeResumeRefusal(refusal),
        );
      }

      // Everything a resumed failure must be true about is checked BEFORE
      // anything moves, so a refusal leaves the run exactly where it was and
      // the user can act on the reason.
      let resumeAttemptEpoch = COLLABORATION_INITIAL_ATTEMPT_EPOCH;
      let claimedTurnGeneration: number | undefined;
      let agents: CollaborationAgentsMap | undefined;
      if (resumingFailure) {
        const read = await deps.readArtifactStream(input.workflowId);
        const ledgerOutcome =
          read.kind === "ok"
            ? buildCollaborationStepLedger({
                stream: read.entries,
                negotiationRounds,
                corruptLineIndexes: read.skipped,
              })
            : read.kind === "absent"
              ? ({ kind: "empty" } as const)
              : ({
                  kind: "unusable",
                  reason: { code: "unreadable", detail: read.error },
                } as const);

        const missingPremises: string[] = [];
        if (!persistedAgentsParse.success) {
          missingPremises.push("agents");
        }
        if (typeof existingSnapshot["claimedTurnGeneration"] !== "number") {
          missingPremises.push("claimedTurnGeneration");
        }
        const recordedEpoch = existingSnapshot["attemptEpoch"];
        if (typeof recordedEpoch !== "number") {
          missingPremises.push("attemptEpoch");
        }

        const failureCauseParse = collaborationFailureCauseSchema.safeParse(
          existingSnapshot["failureCause"],
        );

        const eligibility = decideResumeEligibility({
          status: envelope.status,
          failureCause: failureCauseParse.success
            ? failureCauseParse.data
            : null,
          ledger: ledgerOutcome.kind === "ok" ? ledgerOutcome.ledger : null,
          ledgerRejection:
            ledgerOutcome.kind === "unusable" ? ledgerOutcome.reason : null,
          missingPremises,
          snapshotRoundsCompleted: completedRounds,
        });
        if (eligibility.kind === "refused") {
          throw new CollaborationResumeRefusedError(
            input.workflowId,
            eligibility.refusal,
            describeResumeRefusal(eligibility.refusal),
          );
        }

        if (!persistedAgentsParse.success) {
          throw new Error("Resume eligibility admitted missing agents.");
        }

        agents = await admitCollaborationAgentSelections(
          deps,
          input.projectPath,
          persistedAgentsParse.data,
        );

        claimedTurnGeneration = existingSnapshot[
          "claimedTurnGeneration"
        ] as number;
        resumeAttemptEpoch = (recordedEpoch as number) + 1;

        // Take the conversation back before the envelope moves. A refusal here
        // must leave a failed envelope failed, not a running one with no worker.
        const reclaim = await deps.reclaimConversationOwner({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId,
          owner: {
            kind: "collaboration",
            workflowId: input.workflowId,
            attemptEpoch: resumeAttemptEpoch,
          },
          request: {
            workflowId: input.workflowId,
            claimedTurnGeneration,
          },
        });
        if (reclaim.kind === "refuse") {
          throw new CollaborationConversationOwnershipError(
            input.workflowId,
            reclaim.reason,
            reclaim.detail,
          );
        }
      }

      if (!resumingFailure) {
        if (!persistedAgentsParse.success) {
          throw new Error("Paused collaboration has no persisted agents.");
        }
        agents = await admitCollaborationAgentSelections(
          deps,
          input.projectPath,
          persistedAgentsParse.data,
        );
      }
      if (agents === undefined) {
        throw new Error("Collaboration model selections were not admitted.");
      }

      // A run, including its pause, is one logical turn: the premises the two
      // peers negotiated under are the persisted ones. Parsing before
      // markRunning keeps an unresumable envelope paused rather than stranding
      // it in `running` with no worker.
      const sessionContext = parseSessionContextForExecution(
        existingSnapshot["sessionContext"],
      );

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

      const priorResumeCount =
        typeof existingSnapshot["resumeCount"] === "number"
          ? (existingSnapshot["resumeCount"] as number)
          : 0;
      const updatedSnapshot: Record<string, unknown> = {
        ...existingSnapshot,
        agents,
        userAnswersByQuestionId,
        attemptEpoch: resumeAttemptEpoch,
        ...(resumingFailure
          ? {
              resumeCount: priorResumeCount + 1,
              // Keep what it recovered from; the banner is cleared but the
              // history should survive the run it explains.
              resumedFromErrorSummary: envelope.errorSummary ?? null,
            }
          : {}),
      };

      // The epoch, the snapshot and the status move together: a worker that
      // started against epoch N must never find the record still advertising
      // N-1, and a failed envelope must not be left running without one.
      await repo.update(input.workflowId, {
        status: "running",
        featureSnapshot: updatedSnapshot,
        ...(resumingFailure
          ? { phase: "asymmetric_resumed", errorSummary: undefined }
          : {}),
      });

      const sessionKey = `${input.projectPath}::${input.sessionName}`;
      const laneService = deps.buildLaneService({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      // Replay the same persisted atomic bundles. Current config contributes
      // only timeout bounds; it can never alter a resumed lane's model variant.
      const agentOneRuntime = await resolveRuntimeConfigFor(
        deps,
        agents.agent_one.backend,
      );
      const agentTwoRuntime = await resolveRuntimeConfigFor(
        deps,
        agents.agent_two.backend,
      );
      const callAgent = deps.buildCallAgent({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: session.worktreePath,
        workflowId: input.workflowId,
        conversationId,
        laneService,
        agents: {
          agent_one: laneAgentInput(agents.agent_one, agentOneRuntime),
          agent_two: laneAgentInput(agents.agent_two, agentTwoRuntime),
        },
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
        agents,
        negotiationRounds,
        autonomousResolutionThreshold: autonomousResolutionThreshold.success
          ? autonomousResolutionThreshold.data
          : "major",
        sessionContext,
        conversationId,
        stopSignal: stopController.signal,
        resume: { userAnswersByQuestionId },
        attemptEpoch: resumeAttemptEpoch,
        ...(claimedTurnGeneration !== undefined
          ? { claimedTurnGeneration }
          : {}),
      };

      logger.info("collaboration.manager.resume", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        workflowId: input.workflowId,
        userAnswerCount: Object.keys(parsed.userAnswers).length,
        completedRounds,
        agentOneModelSelection: agents.agent_one.modelSelection,
        agentTwoModelSelection: agents.agent_two.modelSelection,
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

      // Hand the conversation back for the same reason the envelope transition
      // above is unconditional: a paused run has no slice to do it, and an
      // owner nobody clears would refuse every future prompt in that
      // conversation. Idempotent — a live slice that also releases is a no-op.
      const stoppedEpoch = existingSnapshot["attemptEpoch"];
      if (input.conversationId) {
        try {
          await deps.releaseConversationOwner({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            conversationId: input.conversationId,
            owner: {
              kind: "collaboration",
              workflowId: input.workflowId,
              attemptEpoch:
                typeof stoppedEpoch === "number"
                  ? stoppedEpoch
                  : COLLABORATION_INITIAL_ATTEMPT_EPOCH,
            },
          });
        } catch (err) {
          logger.warn("collaboration.manager.stop_release_failed", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            workflowId: input.workflowId,
            error: getErrorMessage(err),
          });
        }
      }

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
      const envelope = await repo.get(input.workflowId);
      if (!envelope) return null;
      return hydrateEnvelopeArtifacts(envelope, deps.readArtifacts);
    },

    async listActive(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listActive();
      const collaboration = all.filter(
        (env) => env.workflowType === "collaboration",
      );
      return Promise.all(
        collaboration.map((env) =>
          hydrateEnvelopeArtifacts(env, deps.readArtifacts),
        ),
      );
    },

    async listAll(input) {
      const repo = deps.createEnvelopeRepository({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const all = await repo.listAll();
      const collaboration = all.filter(
        (env) => env.workflowType === "collaboration",
      );
      return Promise.all(
        collaboration.map((env) =>
          hydrateEnvelopeArtifacts(env, deps.readArtifacts),
        ),
      );
    },
  };
}

/**
 * Re-injects the durable artifact stream into a user-invoked collaboration
 * envelope's `featureSnapshot.artifacts` so the client-visible response shape is
 * unchanged (the client `envelope-adapter.ts` keeps reading
 * `featureSnapshot.artifacts` and never touches the filesystem). Hydration is
 * confined to the user path: non-collaboration envelopes carry no artifact
 * stream, and workflow-invoked collaborations (`origin: "workflow"`) persist a
 * differently-shaped artifact wrapper to the sidecar for durability only and
 * never read it back through the manager — hydrating those with the user schema
 * would silently drop every entry.
 */
async function hydrateEnvelopeArtifacts(
  envelope: WorkflowEnvelope,
  readArtifacts: (workflowId: string) => Promise<CollaborationArtifact[]>,
): Promise<WorkflowEnvelope> {
  if (envelope.workflowType !== "collaboration") return envelope;
  const snapshot = envelope.featureSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return envelope;
  }
  if ((snapshot as Record<string, unknown>).origin === "workflow") {
    return envelope;
  }
  const artifacts = await readArtifacts(envelope.workflowId);
  return {
    ...envelope,
    featureSnapshot: {
      ...(snapshot as Record<string, unknown>),
      artifacts,
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
