import type { SubscriptionRecipient } from "@/lib/subscriptions/schemas";
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";
import type { PreparedSubscriptionBriefing } from "@/lib/subscriptions/service";
import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";

export interface PassiveSubscriptionContextDependencies {
  prepareBriefing(input: {
    recipient: SubscriptionRecipient;
    attemptId: string;
    providedNotepadContext?: readonly NotepadDeliveryRecord[];
  }): Promise<PreparedSubscriptionBriefing>;
  recordAcceptedNotepadReferences?(
    recipient: SubscriptionRecipient,
    references: readonly NotepadDeliveryRecord[],
  ): Promise<void>;
}

export const productionPassiveSubscriptionDependencies: PassiveSubscriptionContextDependencies =
  {
    async prepareBriefing(input) {
      const { getSubscriptionService } =
        await import("@/lib/subscriptions/service-factory");
      return getSubscriptionService().prepareBriefing(input);
    },
    async recordAcceptedNotepadReferences(recipient, references) {
      const { followAcceptedNotepadContext } =
        await import("@/lib/subscriptions/involvement");
      await followAcceptedNotepadContext(recipient, references);
    },
  };

/** A briefing one input carries (the passive briefing, or the runtime-recovery reminder). */
export interface InputBriefing {
  block: string | null;
  onInputAccepted(): Promise<void>;
  markDispatched(): void;
  markDispatchFailure(error: unknown): void;
  finish(): Promise<void>;
}

export const inertBriefingContext: InputBriefing = {
  block: null,
  onInputAccepted: async () => {},
  markDispatched() {},
  markDispatchFailure() {},
  finish: async () => {},
};

export async function preparePassiveSubscriptionContext(
  deps: PassiveSubscriptionContextDependencies | undefined,
  input: {
    recipient: SubscriptionRecipient;
    attemptId: string;
    eligible: boolean;
    providedNotepadContext?: readonly NotepadDeliveryRecord[];
  },
  ownReceipt: (finish: () => Promise<void>) => void,
): Promise<InputBriefing> {
  if (!deps || !input.eligible) return inertBriefingContext;
  const briefing = await deps.prepareBriefing({
    recipient: input.recipient,
    attemptId: input.attemptId,
    providedNotepadContext: input.providedNotepadContext,
  });
  return trackBriefingDelivery(briefing, ownReceipt);
}

/**
 * A prepared briefing as one input carries it: what its sending showed decides
 * how it settles when the input is not accepted (not sent, or uncertain).
 */
export function trackBriefingDelivery(
  briefing: PreparedSubscriptionBriefing,
  ownReceipt: (finish: () => Promise<void>) => void,
): InputBriefing {
  let dispatched = false;
  let provenUndelivered = false;
  let finalized = false;
  const finish = () => {
    finalized = true;
    return briefing.finish({
      disposition: !dispatched || provenUndelivered ? "not_sent" : "uncertain",
    });
  };
  ownReceipt(finish);
  return {
    block: briefing.block,
    onInputAccepted: () => briefing.onInputAccepted(),
    markDispatched() {
      if (finalized)
        throw new Error("Passive subscription input already finalized");
      dispatched = true;
      provenUndelivered = false;
    },
    markDispatchFailure(error) {
      provenUndelivered = isPromptNotDeliveredFailure(error);
    },
    finish,
  };
}
