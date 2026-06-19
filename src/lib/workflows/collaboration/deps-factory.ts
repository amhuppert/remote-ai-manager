/**
 * Production wiring for `AsymmetricCollaborationSliceDeps`.
 *
 * Composes the primitive-layer services into a single deps object so a route
 * handler / manager can call `runAsymmetricCollaborationSlice(input, deps)`
 * without threading every primitive through manually:
 *
 *  - `laneService` is constructed per-call unless the manager passes a shared
 *    instance. Production lane state is session-state backed so backend
 *    continuity refs survive pause/resume and process restart. The production
 *    `laneScheduler` is shared across deps instances so write-capable lanes
 *    from separate runs in the same session serialize against each other on
 *    the session worktree.
 *  - `envelopeStore` is session-scoped: it hangs off the
 *    `(projectPath, sessionName)` pair so durable lifecycle records land in
 *    the correct session state.
 *  - `statusBus` is the production session status bus, so scoped envelopes
 *    (`scope: "collaboration"`) are broadcast through the same SSE pipeline
 *    that drives the rest of the dashboard.
 *  - `callAgent` stays injected. Production callers wrap a `WorkflowAgentCaller`
 *    via `createCollaborationAgentCaller`; tests inject deterministic fakes.
 */

import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  createLaneScheduler,
  type LaneScheduler,
} from "@/lib/workflows/primitives/lane-scheduler";
import {
  createLaneService,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import { createSessionLaneStoreForProduction } from "@/lib/workflows/primitives/lane-store";
import { createSessionWorkflowEnvelopeStoreForProduction } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import type { WorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  createStatusBus,
  type StatusBus,
} from "@/lib/workflows/primitives/status-bus";
import { publishScopedStatusEvent } from "@/lib/workflows/primitives/default-session-status-bus";
import { safeAppendTranscriptEntry } from "@/lib/prompt/transcript";
import { dispatchPushForCollaborationEvent } from "@/lib/push-notification/dispatcher";
import {
  appendCollaborationArtifact,
  readCollaborationArtifacts,
} from "./artifacts-store";
import { collaborationArtifactSchema } from "./types";
import type { AsymmetricCollaborationSliceDeps } from "./envelope";
import { mutateConversation as defaultMutateConversation } from "@/lib/state-store";
import { publishSessionStatus as defaultPublishSessionStatus } from "@/lib/workflows/primitives/default-session-status-bus";

export interface CreateCollaborationDepsInput {
  projectPath: string;
  sessionName: string;
  /**
   * Absolute path to the session worktree. The slice will write artifacts
   * exclusively under this path. Callers MUST resolve this from the session
   * record (`SessionState.worktreePath`) — never substitute the project root,
   * per the worktree-isolation rule in CLAUDE.md.
   */
  worktreePath: string;
  callAgent: AsymmetricCollaborationSliceDeps["callAgent"];
  /**
   * Optional override for the in-process StatusBus the slice publishes scoped
   * `collaboration` envelopes through. When omitted the factory builds a
   * StatusBus whose wire broadcast forwards every envelope onto the shared
   * SSE bus as a `scoped-status` event (`scope: "collaboration"`,
   * `scopeId: workflowId`), so UI consumers receive lifecycle updates
   * through the same EventSource that drives the rest of the dashboard.
   * Tests inject a custom bus to capture envelopes without touching SSE.
   */
  statusBus?: StatusBus;
  /**
   * Optional pre-constructed LaneService. The manager passes the same
   * LaneService to both `buildCallAgent` (production WAC) and `createDeps`
   * so post-turn lane outcomes recorded by WAC land on the same lane state
   * the slice reads in `recordOutcome`. When omitted, a fresh in-memory
   * lane service is constructed for back-compat with non-manager callers.
   */
  laneService?: LaneService;
  /**
   * URL-slug project name used by SSE consumers (matches the `[name]` route
   * segment). When omitted the factory derives it from `path.basename
   * (projectPath)`, which matches the resolver's invariant that projectPath
   * ends in the projectName directory. Provided explicitly so tests can pin
   * a deterministic projectName without filesystem assumptions.
   */
  projectName?: string;
  /**
   * Optional override for the WorkflowEnvelopeStore. Tests inject an
   * in-memory envelope store so they can assert envelope state without
   * bootstrapping the on-disk state manager. Production callers leave
   * this undefined so the envelope persists through the singleton state
   * manager.
   */
  envelopeStore?: WorkflowEnvelopeStore;
  /**
   * Optional scheduler override. Production uses a module-level shared
   * scheduler so concurrent collaboration runs in the same session still
   * serialize write-capable lane work.
   */
  laneScheduler?: LaneScheduler;
  /**
   * Optional override for the conversation state mutation. Tests inject an
   * in-memory fake so they can assert mutator effects (status, unread,
   * pending-question fields) without bootstrapping the on-disk state store.
   */
  mutateConversation?: typeof defaultMutateConversation;
  /**
   * Optional override for the SSE publisher used to broadcast the
   * `conversation-unread` event after `markConversationAwaiting` completes.
   * Tests inject a capturing fake; production routes through the default
   * session status bus so the sidebar updates in real time.
   */
  publishSessionStatus?: typeof defaultPublishSessionStatus;
}

const logger = createLogger("workflows.collaboration.deps-factory");
const defaultCollaborationLaneScheduler = createLaneScheduler();

export function createCollaborationDeps(
  input: CreateCollaborationDepsInput,
): AsymmetricCollaborationSliceDeps {
  const laneService =
    input.laneService ??
    createLaneService({
      store: createSessionLaneStoreForProduction({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      }),
    });
  const laneScheduler =
    input.laneScheduler ?? defaultCollaborationLaneScheduler;

  const envelopeStore =
    input.envelopeStore ??
    createSessionWorkflowEnvelopeStoreForProduction({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });

  const projectName = input.projectName ?? path.basename(input.projectPath);
  const sessionName = input.sessionName;
  const mutateConversation =
    input.mutateConversation ?? defaultMutateConversation;
  const publishSessionStatus =
    input.publishSessionStatus ?? defaultPublishSessionStatus;

  const statusBus =
    input.statusBus ??
    createStatusBus({
      broadcast: (envelope) => {
        // Bridge each in-process StatusBus envelope onto the shared SSE
        // wire as a `scoped-status` event. Delivery failures stay isolated
        // here (caught + logged) so a wire hiccup never propagates back
        // into the workflow that emitted the status.
        const outcome = publishScopedStatusEvent({
          scope: envelope.scope,
          scopeId: envelope.scopeId,
          status: envelope.status,
          timestamp: envelope.timestamp,
          projectName,
          sessionName,
          payload: envelope.payload,
        });
        if (!outcome.delivered) {
          logger.warn("collaboration.status_bus.sse_delivery_failed", {
            scope: envelope.scope,
            scopeId: envelope.scopeId,
            status: envelope.status,
            projectName,
            sessionName,
            error: outcome.error ? getErrorMessage(outcome.error) : "unknown",
          });
        }
      },
    });

  return {
    callAgent: input.callAgent,
    laneService,
    laneScheduler,
    envelopeStore,
    statusBus,
    dispatchPush: (info) => {
      dispatchPushForCollaborationEvent({
        ...info,
        projectName,
        sessionName,
      });
    },
    appendTranscriptEntry: (conversationId, entry) =>
      safeAppendTranscriptEntry(conversationId, entry, undefined, undefined, {
        projectName,
        sessionName,
      }),
    markConversationAwaiting: async (conversationId) => {
      // `unread = true` mirrors the regular conversation finish path
      // (`markUnreadOnFinish`) so the originating conversation pins to
      // "Finished — unread" in the Active Conversations sidebar when the
      // collaboration returns control to the user. Set in the same mutator
      // as `status = "awaiting"` so both fields land atomically.
      await mutateConversation(
        input.projectPath,
        input.sessionName,
        conversationId,
        "collab.conversation_awaiting",
        (conversation) => {
          conversation.status = "awaiting";
          conversation.unread = true;
          conversation.pendingQuestionId = null;
          conversation.pendingQuestions = null;
        },
      );
      publishSessionStatus({
        type: "conversation-unread",
        scope: "session",
        projectName,
        sessionName,
        conversationId,
        unread: true,
      });
    },
    updateConversationBackendRef: (conversationId, ref) =>
      mutateConversation(
        input.projectPath,
        input.sessionName,
        conversationId,
        "collab.backendref_advance",
        (conversation) => {
          conversation.backendRef = ref;
        },
      ),
    appendArtifact: (workflowId, artifact) =>
      appendCollaborationArtifact(workflowId, artifact),
    readArtifacts: (workflowId) =>
      readCollaborationArtifacts(workflowId, collaborationArtifactSchema),
  };
}
