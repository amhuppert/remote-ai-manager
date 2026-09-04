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
 * the next turn; see {@link atRestRuntimeConfiguration}.
 */

import { isRuntimeCreatedWithoutResume } from "@/lib/memory/delivery-decision";
import type { SessionState } from "@/lib/sessions/schemas";

import { resolveAlignmentGateForReusedRuntime } from "./alignment-gate";
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
}

export interface NextTurnContextLossDeps {
  findConversation(
    conversationId: string,
  ): Promise<NextTurnConversationFacts | null>;
  getRuntime(conversationId: string): RecreateRuntimeSnapshot | undefined;
  getSessionCreationMode(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState["creationMode"] | undefined>;
  getActiveAlignmentVersion(
    projectPath: string,
    sessionName: string,
  ): Promise<number | null>;
}

/** A conversation whose next turn carries neither context-loss signal. */
const NO_NEXT_TURN_CONTEXT_LOSS: NextTurnContextLoss = {
  runtimeCreatedWithoutResume: false,
  backendReportedCompactionLastTurn: false,
};

export async function readNextTurnContextLoss(
  deps: NextTurnContextLossDeps,
  conversationId: string,
): Promise<NextTurnContextLoss> {
  const conversation = await deps.findConversation(conversationId);
  if (conversation === null) return NO_NEXT_TURN_CONTEXT_LOSS;

  const runtime = deps.getRuntime(conversationId);
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
      desired: atRestRuntimeConfiguration(
        runtime,
        await resolveDesiredAlignmentVersion(deps, conversation),
      ),
    });

  return {
    runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
      willCreateRuntime,
      promptCount: conversation.promptCount,
      hasResumeHandle: conversation.hasResumeHandle,
    }),
    // Parity with the turn seam, which does not yet observe a backend's own
    // compaction report and passes this false too. When that seam starts
    // reporting, this is the second place that has to read it.
    backendReportedCompactionLastTurn: false,
  };
}

/**
 * The configuration the next turn of a conversation AT REST would run under.
 *
 * Three of its dimensions — the model selection, `outputFormat`, and
 * `fsWritePolicy` — are SUPPLIED AT DISPATCH and unobservable outside a turn.
 * A model override exists only when a caller names one on submission, a schema
 * only when a structured-output request carries it, and a lane's write envelope
 * only once the runner composes it from placement as the turn starts. None of
 * them is held as conversation state, so no reader outside a turn can see the
 * value the next dispatch will supply — not because it cannot change, but
 * because nothing at rest records it. Reading the runtime's own values is
 * therefore this reader's honest answer for a conversation as it stands, and
 * not a claim that the next turn will run under them.
 *
 * The alignment charter version is different: durable project state that
 * `/align` can bump between two turns of an idle conversation. So this reader
 * goes and reads it rather than assuming it.
 *
 * The consequence is an accepted divergence (operator decision, 2026-09-04),
 * pinned by "the dispatch-supplied boundary" in this module's test: a dispatch
 * that supplies a different model, schema, or envelope makes the turn rebuild
 * the runtime, and with no stored resume handle to carry the conversation
 * across it composes a full block where this preview printed a delta.
 * Closing it for `fsWritePolicy` would mean deriving the allowlist outside
 * `composeImplementerLaneWriteEnvelope`, which documents itself as the only
 * place that shape is decided, is fail-closed, and creates directories while
 * resolving: a read-only preview may neither call it nor reimplement it. The
 * full-index command every delta names renders the whole index in one call
 * regardless.
 */
function atRestRuntimeConfiguration(
  runtime: RecreateRuntimeSnapshot,
  desiredAlignmentVersion: number | null,
): DesiredRuntimeConfiguration {
  return {
    modelSelection: runtime.modelSelection,
    alignmentVersion: desiredAlignmentVersion,
    ...(runtime.outputFormat !== undefined
      ? { outputFormat: runtime.outputFormat }
      : {}),
    ...(runtime.fsWritePolicy !== undefined
      ? { fsWritePolicy: runtime.fsWritePolicy }
      : {}),
  };
}

/**
 * The charter version this conversation's next turn would run under, read
 * through the alignment gate that owns the eligibility rule (R12.1/R12.2) so
 * an ineligible session is judged ineligible here for the same reason it is at
 * the turn. `autonomous` is false because it is a dispatch flag rather than
 * conversation state: the next turn of a conversation at rest is an attended
 * one, and a runner that dispatches autonomously supplies that flag itself.
 */
async function resolveDesiredAlignmentVersion(
  deps: NextTurnContextLossDeps,
  conversation: NextTurnConversationFacts,
): Promise<number | null> {
  const { sessionName, projectPath } = conversation;
  // A project conversation has no session and no charter, so the gate would
  // resolve null anyway; skipping spares it a session read that cannot exist.
  if (sessionName === null) return null;
  const gate = await resolveAlignmentGateForReusedRuntime(
    {
      getActiveAlignmentVersion: (path, session) =>
        deps.getActiveAlignmentVersion(path, session),
    },
    {
      projectPath,
      sessionName,
      creationMode: await deps.getSessionCreationMode(projectPath, sessionName),
      isProjectConversation: false,
      autonomous: false,
    },
  );
  return gate.desiredAlignmentVersion;
}
