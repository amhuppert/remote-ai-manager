/**
 * Pre-turn step: deliver a ready CC checkpoint into a fresh runtime and settle
 * its required acceptance receipt.
 *
 * The seed is the frozen payload's exact bytes. Before the provider is called
 * the admitted attempt is bound to the operation — attempt id, the
 * fingerprints of the assembled and the submitted input, and the queued rows
 * it delivers — so a crash between that write and any provider event leaves
 * an attempt that MIGHT have run distinguishable from one that never did.
 * Acceptance needs two facts in either order: the backend's `input_accepted`
 * for this attempt and the fresh opaque reference from `backend_init`; the
 * reference alone proves a session was created, not that the user's input ran
 * in it.
 *
 * Both facts describe one send: the retry policy may replace a runtime that
 * attested non-delivery and send once more, and the runtime that answers that
 * send is the one whose acceptance and reference count, so each dispatch
 * voids what an earlier runtime reported.
 *
 * The accepted input is archived at once, in event order, but the fact of its
 * acceptance is recorded before that fallible write: a failed archive is owed
 * and retried by the receipt, never a reason to forget that the agent ran the
 * input. Everything else the accepted input releases — the queued rows, the
 * context receipts — waits for the acceptance to be durable and the archive
 * to hold what the agent received: a queue advanced on the input event alone
 * would outrun a reference that never arrives or a write that fails, and
 * nothing durable could then repair it. A repaired receipt completes those
 * obligations itself.
 *
 * Settlement classifies every other ending from neutral evidence. The seed
 * returns to ready only when the input was definitely never sent — nothing was
 * dispatched, or the last dispatch attested the prompt never reached the
 * agent. A timeout, an abort mid-flight, a reference, or an absent event is
 * not proof, so those hold the operation for reconciliation instead of
 * risking a replay. An attempt that failed before its binding landed left the
 * seed ready; its receipt still closes the runtime the attempt installed. A
 * failed acceptance write is retained for settlement and repaired by running
 * this same receipt again with the same evidence; the model is never asked
 * twice.
 */

import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";
import type {
  ConversationCheckpointsRepo,
  RecordCheckpointOutcomeInput,
} from "@/lib/conversation-checkpoints/repo";
import type {
  CheckpointDeliveryBinding,
  CheckpointFailure,
  CheckpointPayload,
  CheckpointPhase,
  CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { Logger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/shared/schemas";

export interface CheckpointDeliveryDependencies {
  repo(): Promise<
    Pick<
      ConversationCheckpointsRepo,
      | "getPayload"
      | "beginDelivery"
      | "recordAcceptance"
      | "recordOutcome"
      | "getOperation"
      | "getStateForAdmission"
    >
  >;
  now(): string;
}

/** What the turn observed, as facts the classifier reads. */
export interface CheckpointDeliveryEvidence {
  /** The backend acknowledged this attempt's input. */
  inputAccepted: boolean;
  /** The fresh opaque reference the backend reported, if any. */
  backendRef: string | null;
  /** The provider's send was actually invoked at least once. */
  dispatched: boolean;
  /** The LAST dispatch failed with the adapter's prompt-not-delivered mark. */
  undeliveredFailure: boolean;
}

export type CheckpointDeliveryVerdict =
  | "applied"
  | "accepted_without_reference"
  | "not_sent"
  | "unknown";

export function classifyCheckpointDelivery(
  evidence: CheckpointDeliveryEvidence,
): CheckpointDeliveryVerdict {
  if (evidence.inputAccepted)
    return evidence.backendRef === null
      ? "accepted_without_reference"
      : "applied";
  if (!evidence.dispatched || evidence.undeliveredFailure) return "not_sent";
  return "unknown";
}

/** What an accepted input owes, handed to the receipt with the event. */
export interface CheckpointAcceptanceHandoff {
  /** Archive the accepted input at once, in event order; retried before anything is released. */
  archive?: () => Promise<void>;
  /** Everything else acceptance releases; runs once the acceptance is durable. */
  acknowledge?: () => Promise<void>;
}

export interface PreparedCheckpointSeed {
  readonly operationId: string;
  readonly seedSha256: string;
  /** The exact frozen seed, injected ahead of the actual user input. */
  readonly block: string;
  /** Persist the delivering intent; must complete before the provider call. */
  bind(binding: CheckpointDeliveryBinding): Promise<void>;
  /**
   * The backend accepted this attempt's input. `acknowledge` is everything
   * else that acceptance releases — the queued rows, the context receipts —
   * and runs only once this seed's acceptance is durable; a repaired receipt
   * completes it without a second provider call.
   */
  onInputAccepted(handoff?: CheckpointAcceptanceHandoff): Promise<void>;
  onBackendInit(ref: AgentSessionRef): Promise<void>;
  /** The provider's send is being invoked; what an earlier send observed is void. */
  markDispatched(): void;
  markDispatchFailure(error: unknown): void;
  /** The required receipt, run at attempt settlement and again on repair. */
  finish(): Promise<void>;
}

function logFields(key: CheckpointScopeKey, operationId: string) {
  return {
    scope: key.scope,
    conversationId: key.conversationId,
    ...(key.sessionName === null ? {} : { sessionName: key.sessionName }),
    operationId,
  };
}

export function prepareCheckpointSeed(
  deps: { checkpoint: CheckpointDeliveryDependencies; log: Logger },
  input: {
    key: CheckpointScopeKey;
    operationId: string;
    payload: CheckpointPayload;
    /** Settle the runtime an unsent attempt created, so nothing resumes it. */
    closeAttemptedRuntime(): Promise<void>;
  },
): PreparedCheckpointSeed {
  const { key, operationId, payload } = input;
  const fields = logFields(key, operationId);
  const evidence: CheckpointDeliveryEvidence = {
    inputAccepted: false,
    backendRef: null,
    dispatched: false,
    undeliveredFailure: false,
  };
  let binding: CheckpointDeliveryBinding | undefined;
  /** Fixed when both facts are first known, so a repaired write is identical. */
  let acceptedAt: string | undefined;
  let acceptance: Promise<void> | undefined;
  let acceptanceFailureReported = false;
  let archive: (() => Promise<void>) | undefined;
  let archival: Promise<void> | undefined;
  let archived = false;
  let acknowledge: (() => Promise<void>) | undefined;
  let acknowledgement: Promise<void> | undefined;
  let acknowledged = false;

  async function recordAcceptance(): Promise<void> {
    if (!binding || evidence.backendRef === null)
      throw new Error("checkpoint acceptance needs a binding and a reference");
    acceptedAt ??= deps.checkpoint.now();
    const repo = await deps.checkpoint.repo();
    const result = await repo.recordAcceptance({
      key,
      operationId,
      acceptance: {
        attemptId: binding.attemptId,
        seedHash: payload.seedSha256,
        acceptedAt,
      },
      acceptedBackendRef: evidence.backendRef,
    });
    if (!result.ok)
      throw new Error(
        `checkpoint acceptance refused (${result.refusal.code}): ${result.refusal.reason}`,
      );
    deps.log.info("checkpoint.delivery.accepted", {
      ...fields,
      attemptId: binding.attemptId,
      seedSha256: payload.seedSha256,
    });
  }

  /** Start the acceptance write once both facts are known; returns it. */
  function acceptWhenComplete(): Promise<void> | undefined {
    if (!binding || !evidence.inputAccepted || evidence.backendRef === null)
      return undefined;
    acceptance ??= Promise.resolve().then(recordAcceptance);
    return acceptance;
  }

  /** The archive of the accepted input: once, retried after a failure. */
  function archiveOnce(): Promise<void> {
    if (archived || !archive) return Promise.resolve();
    const run = archive;
    archival ??= Promise.resolve()
      .then(run)
      .then(
        () => {
          archived = true;
        },
        (error: unknown) => {
          archival = undefined;
          throw error;
        },
      );
    return archival;
  }

  /**
   * What the durable acceptance releases, after the archive it presumes —
   * a released row is only ever one whose input the archive holds: once,
   * retried after a failure.
   */
  function acknowledgeOnce(): Promise<void> {
    if (acknowledged || !acknowledge) return Promise.resolve();
    const release = acknowledge;
    acknowledgement ??= archiveOnce()
      .then(release)
      .then(
        () => {
          acknowledged = true;
        },
        (error: unknown) => {
          acknowledgement = undefined;
          throw error;
        },
      );
    return acknowledgement;
  }

  /** From an event handler: the write, then what it releases. */
  function acceptAndAcknowledge(): Promise<void> | undefined {
    return acceptWhenComplete()?.then(acknowledgeOnce);
  }

  async function settleAccepted(): Promise<void> {
    try {
      await acceptance;
    } catch (error) {
      // The first failure is reported once; a repair runs the same write
      // again with the same evidence, and never the provider.
      if (!acceptanceFailureReported) {
        acceptanceFailureReported = true;
        throw error;
      }
      acceptance = undefined;
      await acceptWhenComplete();
    }
    await acknowledgeOnce();
  }

  async function recordOutcome(
    phase: CheckpointPhase,
    failure: CheckpointFailure,
  ): Promise<void> {
    if (!binding) throw new Error("checkpoint outcome needs a binding");
    const repo = await deps.checkpoint.repo();
    const outcome: RecordCheckpointOutcomeInput = {
      key,
      operationId,
      expectedPhase: "delivering",
      attemptId: binding.attemptId,
      phase,
      failure,
      at: deps.checkpoint.now(),
    };
    const result = await repo.recordOutcome(outcome);
    if (result.ok) return;
    // A repaired settlement re-runs this receipt; an outcome this attempt
    // already wrote answers as stale, and the durable phase says so.
    const current = await repo.getOperation(key, operationId);
    if (
      current?.phase === phase &&
      current.delivery?.attemptId === binding.attemptId
    )
      return;
    throw new Error(
      `checkpoint outcome refused (${result.refusal.code}): ${result.refusal.reason}`,
    );
  }

  async function settle(): Promise<void> {
    if (!binding) {
      // Nothing durable names this attempt, so the seed is still ready; only
      // the runtime the attempt installed must not survive to carry the seed
      // as a reused one.
      await input.closeAttemptedRuntime();
      deps.log.warn("checkpoint.delivery.not_sent", {
        ...fields,
        bound: false,
        dispatched: evidence.dispatched,
      });
      return;
    }
    if (acceptance) {
      await settleAccepted();
      return;
    }
    const verdict = classifyCheckpointDelivery(evidence);
    const attemptId = binding.attemptId;
    switch (verdict) {
      case "applied":
        acceptWhenComplete();
        await settleAccepted();
        return;
      case "accepted_without_reference":
        // The agent ran the input, so the archive is owed even though the
        // seed is not applied; a failed archive is retained and repaired
        // like any other receipt work.
        await archiveOnce();
        deps.log.error("checkpoint.delivery.unresolved", {
          ...fields,
          attemptId,
          reason: "acceptance_without_reference",
        });
        await recordOutcome("needs_reconciliation", {
          code: "acceptance_without_reference",
          message:
            "the input was accepted but no fresh provider reference was reported; run compact-context --recover with this operation id",
        });
        return;
      case "not_sent":
        await input.closeAttemptedRuntime();
        deps.log.warn("checkpoint.delivery.not_sent", {
          ...fields,
          attemptId,
          bound: true,
          dispatched: evidence.dispatched,
        });
        await recordOutcome("ready", {
          code: "delivery_not_sent",
          message:
            "the delivery attempt failed before the input reached the provider; the seed is ready for the next ordinary turn",
        });
        return;
      case "unknown":
        deps.log.error("checkpoint.delivery.unresolved", {
          ...fields,
          attemptId,
          reason: "delivery_unresolved",
          backendReported: evidence.backendRef !== null,
        });
        await recordOutcome("needs_reconciliation", {
          code: "delivery_unresolved",
          message:
            "the delivery attempt ended without acceptance evidence; review queued deliveries, then run checkpoint reconcile or compact-context --recover",
        });
        return;
    }
  }

  return {
    operationId,
    seedSha256: payload.seedSha256,
    block: payload.seedText,
    async bind(next) {
      const repo = await deps.checkpoint.repo();
      const result = await repo.beginDelivery({
        key,
        operationId,
        binding: next,
        at: deps.checkpoint.now(),
      });
      if (!result.ok) {
        deps.log.warn("checkpoint.delivery.bind_refused", {
          ...fields,
          attemptId: next.attemptId,
          code: result.refusal.code,
        });
        throw new Error(
          `checkpoint delivery refused (${result.refusal.code}): ${result.refusal.reason}`,
        );
      }
      binding = next;
      deps.log.info("checkpoint.delivery.bound", {
        ...fields,
        attemptId: next.attemptId,
        queuedAttemptId: next.queuedAttemptId,
        queuedMessageId: next.queuedMessageId,
      });
    },
    async onInputAccepted(handoff) {
      // The fact and its obligations are recorded before anything fallible
      // runs, so a failed archive or write leaves them for settlement.
      evidence.inputAccepted = true;
      archive ??= handoff?.archive;
      acknowledge ??= handoff?.acknowledge;
      // The archive runs at once, in event order; the acceptance write needs
      // no archive and starts alongside it; the release waits for both.
      const archival = archiveOnce();
      const accepted = acceptWhenComplete();
      // Settlement reports a failure here as well; it must not surface as an
      // unhandled rejection when the event handler is the only awaiter.
      void archival.catch(() => {});
      void accepted?.catch(() => {});
      await archival;
      await accepted;
      if (accepted) await acknowledgeOnce();
    },
    async onBackendInit(ref) {
      evidence.backendRef = ref.ref;
      const started = acceptAndAcknowledge();
      void started?.catch(() => {});
      await started;
    },
    markDispatched() {
      // Every send is its own delivery: the runtime answering this dispatch
      // is the one whose acceptance and reference count, so an earlier
      // runtime's evidence is void — unless it already reached the acceptance
      // write, which no later send can take back.
      if (!acceptance) {
        evidence.inputAccepted = false;
        evidence.backendRef = null;
      }
      evidence.dispatched = true;
      evidence.undeliveredFailure = false;
    },
    markDispatchFailure(error) {
      evidence.undeliveredFailure = isPromptNotDeliveredFailure(error);
      deps.log.debug("checkpoint.delivery.dispatch_failed", {
        ...fields,
        undelivered: evidence.undeliveredFailure,
        ...checkpointErrorFields(error),
      });
    },
    finish: settle,
  };
}
