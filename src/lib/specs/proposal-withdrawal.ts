import { z } from "zod";

import {
  agentActorProvenanceSchema,
  type ActorProvenance,
  type AgentActorProvenance,
  type SpecEventRow,
  type SpecRevision,
} from "./schemas";
import type { TransitionRefusal } from "./transitions";

/**
 * Whether a proposing agent may end its own review attempt. Every condition is
 * decided here, over the durable record, so the answer is the same on every
 * surface and can be exercised without a transaction.
 *
 * Two of the conditions are why this is not a widening of the human withdraw:
 * authorship is the caller's licence to act, and a human who has already
 * engaged with the attempt owns how it ends.
 */
export interface ProposalWithdrawalContext {
  readonly revision: Pick<SpecRevision, "id" | "number" | "state">;
  /** The conversation asking to withdraw, from the transport's provenance. */
  readonly caller: ActorProvenance;
  /** The spec's durable events, oldest first. */
  readonly events: readonly SpecEventRow[];
  /**
   * Threads on this attempt a human resolved or dismissed. Read from the
   * comment rows rather than the attention log: a resolution is recorded
   * against one (revision, thread) pair and is never undone, while the
   * attention event carries only the thread id and threads outlive revisions.
   */
  readonly endedThreadIds: readonly string[];
}

export type ProposalWithdrawalDecision =
  | {
      readonly ok: true;
      /** The conversation the propose event attributes the revision to. */
      readonly proposer: AgentActorProvenance;
      /**
       * The caller, narrowed by the same check that matched it to the
       * proposer. It is recorded separately because the two carry independent
       * backends: the same conversation can propose from one and withdraw
       * from another.
       */
      readonly withdrawnBy: AgentActorProvenance;
    }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

const proposedPayloadSchema = z.object({
  kind: z.literal("proposed"),
  revisionId: z.string().min(1),
});

const revisionScopedPayloadSchema = z.object({
  revisionId: z.string().min(1),
});

/**
 * The event types that record a human deciding something about the content
 * under review. `spec-review-revision-signed-off` is absent on purpose: a
 * signed-off revision is approved, which the state check refuses first.
 */
const HUMAN_APPROVAL_EVENT_TYPES = new Set([
  "spec-review-item-approved",
  "spec-review-item-unapproved",
]);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function eventTouchesRevision(
  event: SpecEventRow,
  revisionId: string,
): boolean {
  const payload = revisionScopedPayloadSchema.safeParse(
    parseJson(event.payload_json),
  );
  return payload.success && payload.data.revisionId === revisionId;
}

/**
 * The agent conversation the durable propose event attributes the revision to,
 * or null when nothing identifies one — an absent event, an unreadable actor,
 * an agent actor with no conversation, or a human propose. All four collapse
 * to the same answer because all four mean the same thing: this server cannot
 * name an agent that owns the proposal.
 */
export function proposalAuthor(
  events: readonly SpecEventRow[],
  revisionId: string,
): AgentActorProvenance | null {
  const proposeEvent = events.findLast(
    (event) =>
      event.event_type === "spec-revision-changed" &&
      proposedPayloadSchema.safeParse(parseJson(event.payload_json)).success &&
      eventTouchesRevision(event, revisionId),
  );
  if (proposeEvent === undefined) return null;
  const actor = agentActorProvenanceSchema.safeParse(
    parseJson(proposeEvent.actor_json),
  );
  return actor.success ? actor.data : null;
}

function notOwned(
  unmetConditions: string[],
  instruction: string,
): ProposalWithdrawalDecision {
  return {
    ok: false,
    refusal: { code: "proposal_not_owned", unmetConditions, instruction },
  };
}

function humanHasActed(context: ProposalWithdrawalContext): string | null {
  const approval = context.events.find(
    (event) =>
      HUMAN_APPROVAL_EVENT_TYPES.has(event.event_type) &&
      eventTouchesRevision(event, context.revision.id) &&
      !agentActorProvenanceSchema.safeParse(parseJson(event.actor_json))
        .success,
  );
  if (approval !== undefined) {
    return "a human has already approved or unapproved content on it";
  }
  const thread = context.endedThreadIds[0];
  return thread === undefined
    ? null
    : `a human has already resolved review thread ${thread} on it`;
}

export function evaluateProposalWithdrawal(
  context: ProposalWithdrawalContext,
): ProposalWithdrawalDecision {
  const { revision, caller } = context;
  if (caller.kind !== "agent") {
    return notOwned(
      ["Withdrawing a proposal is the proposing agent's own act."],
      "End the review from Spec Studio instead: Request Changes reopens the revision as a draft, and Withdraw ends it without one.",
    );
  }
  if (revision.state !== "proposed") {
    return {
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          `Revision ${revision.number} is ${revision.state}, so it carries no proposal to withdraw.`,
        ],
        instruction:
          "Read the spec's status for the revision under review now. --revision is the token the propose returned and is never inferred, so a stale one withdraws nothing.",
      },
    };
  }
  const proposer = proposalAuthor(context.events, revision.id);
  if (proposer === null) {
    return notOwned(
      [
        `No agent conversation is recorded as the author of revision ${revision.number}.`,
      ],
      "Ask a human to end this review in Spec Studio: without a recorded agent author there is no proposer to withdraw on behalf of.",
    );
  }
  if (proposer.conversationId !== caller.conversationId) {
    return notOwned(
      [`Revision ${revision.number} was proposed by another conversation.`],
      "Only the conversation that proposed a revision withdraws it, and a successor conversation is not its author. Ask a human to Request Changes on it in Spec Studio.",
    );
  }
  const humanAct = humanHasActed(context);
  if (humanAct !== null) {
    return {
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          `Revision ${revision.number} is no longer an untouched proposal: ${humanAct}.`,
        ],
        instruction:
          "Ask a human to Request Changes on this revision in Spec Studio. An attempt a human has acted on ends on their terms, not by the author erasing it.",
      },
    };
  }
  return { ok: true, proposer, withdrawnBy: caller };
}
