/**
 * Pre-turn step read from OUTSIDE a turn: the context-loss signals a
 * conversation's next turn would carry (memory spec D4).
 *
 * The memory index preview renders the block due for the conversation AS IT
 * STANDS, and a context loss makes that block a full one however far the
 * delivery sequence has advanced. Answering that means asking the same runtime
 * question the turn asks — which is why the rule itself lives in
 * `runtime-recreate.ts` and both callers go through it rather than each keeping
 * a copy. What this cannot answer is the configuration a dispatcher will hand
 * the next turn; see the dispatch boundary documented below.
 */

import { isRuntimeCreatedWithoutResume } from "@/lib/memory/delivery-decision";

import {
  willNextTurnCreateRuntime,
  type DesiredRuntimeConfiguration,
  type RecreateRuntimeSnapshot,
} from "./runtime-recreate";

export interface NextTurnContextLoss {
  readonly runtimeCreatedWithoutResume: boolean;
  readonly backendReportedCompactionLastTurn: boolean;
}

/** The conversation state this prediction reads, in either scope. */
export interface NextTurnConversationFacts {
  readonly projectPath: string;
  /** null for a project conversation, which has no session and no charter. */
  readonly sessionName: string | null;
  /** Turns this conversation has already completed. */
  readonly promptCount: number;
  /** Whether a stored backend handle lets a new runtime resume. */
  readonly hasResumeHandle: boolean;
  /** A ready CC checkpoint will seed the next turn's fresh runtime. */
  readonly pendingCheckpoint: boolean;
}

export interface NextTurnContextLossDeps {
  findConversation(
    conversationId: string,
  ): Promise<NextTurnConversationFacts | null>;
  getRuntimeConfiguration(
    conversationId: string,
  ): RecreateRuntimeSnapshot | undefined;
  readDesiredRuntimeConfiguration(
    conversationId: string,
    current: DesiredRuntimeConfiguration,
  ): Promise<DesiredRuntimeConfiguration>;
}

/** A conversation whose next turn carries neither context-loss signal. */
const NO_NEXT_TURN_CONTEXT_LOSS: NextTurnContextLoss = {
  runtimeCreatedWithoutResume: false,
  backendReportedCompactionLastTurn: false,
};

/**
 * The configuration the next turn of a conversation AT REST would run under.
 *
 * Two of its dimensions — the model selection and `fsWritePolicy` — are
 * supplied at dispatch and unobservable outside a turn. A model override exists
 * only when a caller names one on submission, and a lane's write envelope
 * only once the runner composes it from placement as the turn starts. None of
 * them is held as conversation state, so no reader outside a turn can see the
 * value the next dispatch will supply — not because it cannot change, but
 * because nothing at rest records it. Reading the runtime's own values is
 * therefore this reader's honest answer for a conversation as it stands, and
 * not a claim that the next turn will run under them.
 *
 * Repeatable instructions are different: TDD, references, profile and alignment
 * come from durable state. The managed projection renders them again with the
 * currently known ask/autonomy selection, without registering or draining anything.
 *
 * The consequence is an accepted divergence (operator decision, 2026-09-04),
 * pinned by "the dispatch-supplied boundary" in this module's test: a dispatch
 * that supplies a different model or envelope makes the turn rebuild
 * the runtime, and with no stored resume handle to carry the conversation
 * across it composes a full block where this preview printed a delta.
 * Closing it for `fsWritePolicy` would mean deriving the allowlist outside
 * `composeImplementerLaneWriteEnvelope`, which documents itself as the only
 * place that shape is decided, is fail-closed, and creates directories while
 * resolving: a read-only preview may neither call it nor reimplement it. The
 * full-index command every delta names renders the whole index in one call
 * regardless.
 */

export async function readNextTurnContextLoss(
  deps: NextTurnContextLossDeps,
  conversationId: string,
): Promise<NextTurnContextLoss> {
  const conversation = await deps.findConversation(conversationId);
  if (conversation === null) return NO_NEXT_TURN_CONTEXT_LOSS;

  const runtime = deps.getRuntimeConfiguration(conversationId);
  // A registered runtime the next turn can reuse is the whole difference
  // between resuming and starting over. Reusability is not "is it alive" — the
  // turn closes a live runtime whose baked configuration has drifted — so the
  // question goes through the same rule the turn applies, against the only
  // configuration a reader outside a turn can know: the one this conversation
  // stands at.
  const willCreateRuntime =
    runtime === undefined ||
    runtime.status === "dead" ||
    willNextTurnCreateRuntime({
      runtime,
      desired: await deps.readDesiredRuntimeConfiguration(
        conversationId,
        runtime,
      ),
    });

  return {
    runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
      willCreateRuntime,
      promptCount: conversation.promptCount,
      hasResumeHandle: conversation.hasResumeHandle,
      pendingCheckpoint: conversation.pendingCheckpoint,
    }),
    // Parity with the turn seam, which does not yet observe a backend's own
    // compaction report and passes this false too. When that seam starts
    // reporting, this is the second place that has to read it.
    backendReportedCompactionLastTurn: false,
  };
}
