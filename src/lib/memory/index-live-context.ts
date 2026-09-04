import type { ConversationRole } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";

import type { MemoryPolicySubject } from "./delivery-policy";
import { decideMemoryIndexDelivery } from "./delivery-decision";
import type {
  MemoryIndexBlock,
  MemoryIndexComposer,
  MemoryIndexEntry,
} from "./index-composer";
import type {
  MemoryArtifactRef,
  MemoryIndexBudget,
  MemoryIndexDeliveryKind,
  MemoryReadPolicy,
  MemoryVisibility,
} from "./schemas";
import type { MemoryIndexDeliveryRead } from "./telemetry";

/**
 * The per-turn live-context provider for the `<memory-index>` block (spec R5,
 * R6, D4), mirroring the `<active-ticket>` provider: it re-reads live rows on
 * every call and is never baked into a runtime's session instructions, so a
 * note captured anywhere is in this conversation's next turn with no restart.
 */

const logger = createLogger("memory.live-context");

export interface MemoryIndexContextRequest {
  readonly projectPath: string;
  readonly conversationId: string;
  readonly conversation:
    | { readonly kind: "session"; readonly sessionName: string }
    | { readonly kind: "project" };
  readonly role: ConversationRole;
  /** The graph-workflow execution a lane conversation runs inside; null otherwise. */
  readonly workflowExecutionId: string | null;
  /** The execution context the lane drives; null outside a lane. */
  readonly workflowContextId: string | null;
  /** A continuing conversation had to create a runtime with no resume handle. */
  readonly runtimeCreatedWithoutResume: boolean;
  /** The previous backend turn reported that it compacted its own context. */
  readonly backendReportedCompactionLastTurn: boolean;
}

export interface MemoryIndexContextProviderDeps {
  composer: MemoryIndexComposer;
  /** The session incarnation's created-at, or null when no such session row exists. */
  findSessionCreatedAt(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
  /** The linked ticket's immutable id, or null when the session is unlinked. */
  findLinkedTicketId(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
  /**
   * The immutable id of the spec a native-SDD run is bound to, or null when
   * the graph execution is not a spec delivery. May throw on a stale link.
   */
  findBoundSpecId(workflowExecutionId: string): Promise<string | null>;
  /** The budget as global settings hold it right now, re-read per call (R10.3). */
  readBudget(): Promise<MemoryIndexBudget>;
  /**
   * The conversation's read policy through the configuration cascade (R10,
   * D7), re-resolved per call: global settings for an ordinary conversation,
   * the execution context's seeded per-role policy for a lane.
   */
  resolveReadPolicy(subject: MemoryPolicySubject): Promise<MemoryReadPolicy>;
  /** The delivery state and index-channel watermarks read before composition. */
  readIndexDelivery(conversationId: string): Promise<MemoryIndexDeliveryRead>;
  /** Clear index delivery state and watermarks after a context loss. */
  resetIndexDelivery(conversationId: string): Promise<void>;
  /** The instant attached to the prepared delivery and settled after acceptance. */
  now(): string;
}

export interface PreparedMemoryIndexDelivery {
  readonly mode: MemoryIndexDeliveryKind;
  readonly composedAt: string;
  readonly entries: readonly MemoryIndexEntry[];
  readonly block: string | null;
  /** Composition metadata retained for preview surfaces; never settled. */
  readonly rendered: MemoryIndexBlock | null;
}

/**
 * What a preview asks to see (R12): the delivery this conversation's NEXT turn
 * is due — full or delta according to where it stands — or the full block
 * whatever that state says.
 */
export type MemoryIndexPreviewMode = "next-turn" | "full";

export interface MemoryIndexContextProvider {
  /**
   * The delivery prepared for this turn, or null when its read policy is off.
   * A prepared delivery exists even when its rendered block or entry list is
   * empty, because acceptance must still advance the conversation's state.
   */
  getForConversation(
    request: MemoryIndexContextRequest,
  ): Promise<PreparedMemoryIndexDelivery | null>;
  /**
   * The same composition with none of the turn's side effects: a preview never
   * resets the conversation's index delivery state, and nothing settles it
   * afterwards. Reading the block a turn is due must not change the block that
   * turn gets (R12) — otherwise looking at a conversation's memory would
   * silently spend its full-block delivery.
   */
  previewForConversation(
    request: MemoryIndexContextRequest,
    mode: MemoryIndexPreviewMode,
  ): Promise<PreparedMemoryIndexDelivery | null>;
}

export function createMemoryIndexContextProvider(
  deps: MemoryIndexContextProviderDeps,
): MemoryIndexContextProvider {
  /**
   * `settle: false` is the preview path: the decision is computed the same way
   * so a preview cannot disagree with the turn about what is due, but a reset
   * it calls for is not performed — the conversation still holds whatever the
   * turn seam last settled.
   */
  async function prepare(
    request: MemoryIndexContextRequest,
    options: { readonly settle: boolean; readonly force: "full" | null },
  ): Promise<PreparedMemoryIndexDelivery | null> {
    const startedAt = performance.now();
    const policy = await deps.resolveReadPolicy({
      projectPath: request.projectPath,
      conversation: request.conversation,
      role: request.role,
      // A lane is identified by BOTH ids: an execution without a context is
      // no lane identity at all, and resolving it as one would let a
      // non-lane conversation read a context's policy.
      workflow:
        request.workflowExecutionId !== null &&
        request.workflowContextId !== null
          ? {
              executionId: request.workflowExecutionId,
              contextId: request.workflowContextId,
            }
          : null,
    });
    if (policy === "off") {
      logger.debug("memory.live-context.off", {
        conversationId: request.conversationId,
        scope: request.conversation.kind,
        role: request.role,
        durationMs: performance.now() - startedAt,
      });
      return null;
    }

    const deliveryRead = await deps.readIndexDelivery(request.conversationId);
    const decision = decideMemoryIndexDelivery({
      hasDeliveryState: deliveryRead.state !== null,
      runtimeCreatedWithoutResume: request.runtimeCreatedWithoutResume,
      backendReportedCompactionLastTurn:
        request.backendReportedCompactionLastTurn,
    });
    // A reset is a WRITE, so only the turn performs it: a preview that reset
    // a compacted conversation's state would settle nothing afterwards and
    // leave the sequence claiming a full block nobody was given.
    if (decision.reset && options.settle) {
      await deps.resetIndexDelivery(request.conversationId);
    }
    const mode: MemoryIndexDeliveryKind = options.force ?? decision.mode;

    let visibility: MemoryVisibility = {
      projectPath: request.projectPath,
      session: null,
    };
    const activeArtifacts: MemoryArtifactRef[] = [];
    let lane: MemoryArtifactRef | null = null;
    if (request.conversation.kind === "session") {
      const { sessionName } = request.conversation;
      const createdAt = await deps.findSessionCreatedAt(
        request.projectPath,
        sessionName,
      );
      if (createdAt === null) {
        // Session notes bind to an incarnation (R3.1) and there is none to
        // bind to, so the turn reads at project visibility rather than
        // failing over a missing row.
        logger.warn("memory.live-context.session_unresolved", {
          conversationId: request.conversationId,
          sessionName,
        });
      } else {
        visibility = {
          projectPath: request.projectPath,
          session: { sessionName, sessionCreatedAt: createdAt },
        };
      }
      const ticketId = await deps.findLinkedTicketId(
        request.projectPath,
        sessionName,
      );
      if (ticketId !== null) {
        activeArtifacts.push({ kind: "ticket", ticketId });
      }
    }
    if (request.workflowExecutionId !== null) {
      // A spec delivery's bound spec is an active artifact of every lane in
      // the run (R5.3). A stale spec link is that subsystem's corruption
      // signal, not a reason to drop the whole block: the turn still gets
      // its ticket and execution cues.
      try {
        const specId = await deps.findBoundSpecId(request.workflowExecutionId);
        if (specId !== null) activeArtifacts.push({ kind: "spec", specId });
      } catch (err) {
        logger.warn("memory.live-context.spec_unresolved", {
          conversationId: request.conversationId,
          workflowExecutionId: request.workflowExecutionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      activeArtifacts.push({
        kind: "workflow_execution",
        executionId: request.workflowExecutionId,
      });
      if (request.workflowContextId !== null) {
        lane = {
          kind: "workflow_context",
          executionId: request.workflowExecutionId,
          contextId: request.workflowContextId,
        };
        activeArtifacts.push(lane);
      }
    }

    // Linked-only is exact to the context under validation (R10.1): a lane
    // reads only what was deliberately attached to its OWN execution
    // context — not the run's, not a sibling's, not the ticket's — so
    // nothing execution-wide can prime it. An ordinary conversation has no
    // context and keeps its ticket and spec cues.
    const deliveredArtifacts =
      policy === "linked-only" && lane !== null ? [lane] : activeArtifacts;

    const budget = await deps.readBudget();
    const subject = {
      conversation: request.conversation,
      visibility,
      activeArtifacts: deliveredArtifacts,
      delivery: policy,
    } as const;
    const composedAt = deps.now();
    let block: MemoryIndexBlock | null;
    if (mode === "full") {
      block = await deps.composer.compose(subject, budget);
    } else {
      if (deliveryRead.state === null) {
        throw new Error("Delta delivery requires an existing delivery state");
      }
      block = await deps.composer.composeDelta(subject, budget, {
        state: deliveryRead.state,
        watermarks: deliveryRead.watermarks,
      });
    }
    const prepared: PreparedMemoryIndexDelivery = {
      mode,
      composedAt,
      entries: block?.entries ?? [],
      block: block?.text ?? null,
      rendered: block,
    };
    logger.debug("memory.live-context.prepared", {
      conversationId: request.conversationId,
      mode: prepared.mode,
      entryCount: prepared.entries.length,
      omittedCount: block?.omitted ?? 0,
      bytes: block?.bytes ?? 0,
    });
    return prepared;
  }

  return {
    getForConversation: (request) =>
      prepare(request, { settle: true, force: null }),
    previewForConversation: (request, mode) =>
      prepare(request, {
        settle: false,
        force: mode === "full" ? "full" : null,
      }),
  };
}
