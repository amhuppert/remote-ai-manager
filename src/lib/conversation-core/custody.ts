import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
} from "@/lib/agent-backends/conversation";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  TranscriptBroadcastMeta,
  TranscriptEntry,
} from "@/lib/prompt/transcript";
import {
  segmentUsageOf,
  type ConversationIdentity,
  type CustodyRecordPort,
  type TurnSource,
} from "./conversation-record";
import type { CustodyLease, CustodyOpener } from "./executor";
import type { RunningTurnDescription } from "./interactive-turns";
import type {
  HostedConversation,
  RuntimeHost,
  RuntimeRequirements,
} from "./runtime-host";
import type { CustodyEnd } from "./schemas";

/** How a custody's runtime ended with work cut short, for the loss its next turn hears about. */
export type CustodyLossEnd = Exclude<CustodyEnd, "settled" | "handed_over">;

/** Why work kept between turns was cut short: how its custody ended, or a handover whose turn needed a fresh process. */
export type CustodyLossReason = CustodyLossEnd | "reconfigured";

export interface RuntimeCustodyDeps {
  host: Pick<RuntimeHost, "runtime" | "release" | "drift" | "closeFailure">;
  records: CustodyRecordPort;
  /** Appends a frame of a provider turn to the conversation's transcript. */
  appendFrame(
    conversationId: string,
    entry: TranscriptEntry,
    meta: TranscriptBroadcastMeta,
  ): Promise<void>;
  /** Applies capability changes staged while the runtime was busy (design C5b §4.1 step 2). */
  applyStagedCapabilities(conversation: HostedConversation): Promise<void>;
  /** Records, for the conversation's next turn, the loss of work a closed runtime cut short; `key` makes it once. */
  recordLoss(input: {
    identity: ConversationIdentity;
    key: string;
    end: CustodyLossReason;
    collected: boolean;
  }): Promise<void>;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** The turn whose end a custody keeps the runtime for: what custody's provider turns inherit. */
export interface CustodyTurn {
  source: TurnSource;
  autonomous: boolean;
  originMessageId: string | null;
}

export interface RuntimeCustody {
  /** The callbacks an ordinary conversation's runtime reports its own turns, owed work and death through. */
  callbacks(
    conversation: HostedConversation,
    track: (work: Promise<void>) => void,
  ): Pick<
    ConversationBackendCreateInput,
    "onExternalTurnEvent" | "onOwedWorkChanged" | "onTerminated"
  >;
  /**
   * At an ordinary interactive turn's end: custody keeps the conversation's
   * runtime when it still owes provider work, and the lease is returned;
   * null means the runtime is to be released as usual.
   */
  keep(
    conversationId: string,
    turn: CustodyTurn,
    opener: CustodyOpener,
  ): CustodyLease | null;
  /**
   * Before a turn on a runtime custody handed over prepares its input: a
   * runtime whose configuration drifted is closed first, recording the work
   * it cut short so the turn's own input carries the loss; otherwise
   * capability changes staged meanwhile apply when no provider turn runs.
   */
  takeOver(
    conversation: HostedConversation,
    requirements: RuntimeRequirements,
    turnAttemptId: string,
  ): Promise<void>;
  /** The provider turn custody runs now, as the conversation's running turn. */
  describe(conversationId: string): RunningTurnDescription | null;
}

/** One runtime's provider turns and the custody, if any, that holds it now. */
interface Retention {
  conversation: HostedConversation;
  identity: ConversationIdentity;
  meta: TranscriptBroadcastMeta;
  /** A provider turn is running: set as its start is received, cleared as its end is. */
  segment: boolean;
  lease: CustodyLease | null;
  turn: CustodyTurn | null;
  /** The runtime's events, handled one after another in the order it reported them. */
  chain: Promise<void>;
  track(work: Promise<void>): void;
}

/**
 * The runtime side of custody (design C5b §3): the provider's own turns in a
 * runtime kept between turns reach the transcript and the row of whoever owns
 * the runtime, and its owed work and death end the custody that holds it.
 * Each runtime's events are handled in order and held open until it closes;
 * none waits for that close, which waits for them.
 */
export function createRuntimeCustody(deps: RuntimeCustodyDeps): RuntimeCustody {
  /** The latest runtime of each conversation. */
  const retentions = new Map<string, Retention>();

  function then(retention: Retention, step: () => Promise<void>): void {
    const next = retention.chain.then(step).catch((error: unknown) =>
      deps.log.error("conversation_core.custody_event_failed", {
        conversationId: retention.conversation.conversationId,
        error: getErrorMessage(error),
      }),
    );
    retention.chain = next;
    retention.track(next);
  }

  async function applyStaged(retention: Retention): Promise<void> {
    await deps
      .applyStagedCapabilities(retention.conversation)
      .catch((error: unknown) =>
        deps.log.warn("conversation_core.staged_capabilities_failed", {
          conversationId: retention.conversation.conversationId,
          error: getErrorMessage(error),
        }),
      );
  }

  function onEvent(
    retention: Retention,
    event: ConversationBackendEvent,
  ): void {
    const { conversationId } = retention.conversation;
    switch (event.type) {
      case "external_turn_started": {
        retention.segment = true;
        // The owner when the provider reported it, however long the chain takes to get here.
        const lease = retention.lease;
        then(retention, async () => {
          // A turn that owns the runtime owns the row too.
          if (lease === null) return;
          await deps.records.recordSegment(retention.identity, null, () =>
            lease.row(),
          );
        });
        return;
      }
      case "transcript_entry": {
        const entry = conversationTranscriptFrame(event.entry);
        then(retention, () =>
          deps
            .appendFrame(conversationId, entry, retention.meta)
            .catch((error: unknown) =>
              deps.log.warn("conversation_core.provider_frame_append_failed", {
                conversationId,
                error: getErrorMessage(error),
              }),
            ),
        );
        return;
      }
      case "external_turn_completed": {
        retention.segment = false;
        const usage = segmentUsageOf(event.result);
        const lease = retention.lease;
        then(retention, async () => {
          try {
            // Its usage is the conversation's whoever owns the runtime: a turn that took it over is charged only its own.
            await deps.records.recordSegment(
              retention.identity,
              usage,
              () => lease?.row(true) ?? null,
            );
          } finally {
            // A message the queue held for this provider turn's end hands over even if the row write failed.
            if (lease !== null) {
              if (!retention.segment && retention.lease === lease)
                await applyStaged(retention);
              lease.segmentEnded();
            }
          }
        });
        return;
      }
      default:
        return;
    }
  }

  return {
    callbacks(conversation, track) {
      const storeSessionName = conversationTargetStoreSessionName(
        conversation.target,
      );
      const retention: Retention = {
        conversation,
        identity: {
          projectPath: conversation.projectPath,
          storeSessionName,
          conversationId: conversation.conversationId,
        },
        meta: { projectName: conversation.projectName, storeSessionName },
        segment: false,
        lease: null,
        turn: null,
        chain: Promise.resolve(),
        track,
      };
      retentions.set(conversation.conversationId, retention);
      return {
        onExternalTurnEvent: (event) => onEvent(retention, event),
        onOwedWorkChanged(owesWork) {
          if (owesWork) return;
          then(retention, async () => {
            const lease = retention.lease;
            if (lease === null) return;
            // The notice trails the runtime's own answer, which is the truth now.
            const runtime = deps.host.runtime(conversation.conversationId);
            if (runtime?.owesWork?.() === true) return;
            lease.settled();
          });
        },
        // Also reported when custody itself closes the runtime, which an ending custody ignores.
        onTerminated() {
          then(retention, async () => {
            retention.lease?.lost();
          });
        },
      };
    },

    keep(conversationId, turn, opener) {
      const retention = retentions.get(conversationId);
      const runtime = deps.host.runtime(conversationId);
      if (
        retention === undefined ||
        runtime === null ||
        runtime.owesWork?.() !== true
      )
        return null;
      let lease: CustodyLease | null = null;
      lease = opener.open({
        segmentActive: () => retention.segment,
        close: () => deps.host.release(conversationId),
        closeFailure: () => deps.host.closeFailure(conversationId),
        released() {
          if (retention.lease !== lease) return;
          retention.lease = null;
          retention.turn = null;
        },
      });
      if (lease === null) return null;
      retention.lease = lease;
      retention.turn = turn;
      // The turn's end is a provider-turn boundary when no provider turn runs.
      if (!retention.segment) then(retention, () => applyStaged(retention));
      return lease;
    },

    async takeOver(conversation, requirements, turnAttemptId) {
      const { conversationId } = conversation;
      const changes = await deps.host.drift(conversation, requirements);
      if (changes.length > 0) {
        const owed = deps.host.runtime(conversationId)?.owesWork?.() === true;
        deps.log.info("conversation_core.custody_runtime_drifted", {
          conversationId,
          changes,
          owed,
        });
        // A close that cannot be confirmed fails the turn, which keeps its grant: no loss is claimed.
        await deps.host.release(conversationId);
        if (owed)
          await deps.recordLoss({
            identity: {
              projectPath: conversation.projectPath,
              storeSessionName: conversationTargetStoreSessionName(
                conversation.target,
              ),
              conversationId,
            },
            key: `drift:${turnAttemptId}`,
            end: "reconfigured",
            collected: true,
          });
        return;
      }
      const retention = retentions.get(conversationId);
      if (retention !== undefined && !retention.segment)
        await applyStaged(retention);
    },

    describe(conversationId) {
      const retention = retentions.get(conversationId);
      if (
        retention === undefined ||
        retention.lease === null ||
        retention.turn === null ||
        !retention.segment
      )
        return null;
      return {
        autonomous: retention.turn.autonomous,
        originMessageId: retention.turn.originMessageId,
      };
    },
  };
}
