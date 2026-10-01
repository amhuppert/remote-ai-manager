import type { SubscriptionRecipient } from "@/lib/subscriptions/schemas";
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";
import type { PreparedSubscriptionBriefing } from "@/lib/subscriptions/service";
import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";
import { createRequiredInputReceipt } from "./required-input-receipt";

export interface PassiveSubscriptionContextDependencies {
  synchronizeInvolvement(recipient: SubscriptionRecipient): Promise<void>;
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
    async synchronizeInvolvement(recipient) {
      const { synchronizeSubscriptionInvolvement } =
        await import("@/lib/subscriptions/involvement");
      await synchronizeSubscriptionInvolvement(recipient);
    },
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

export function prepareAcceptedNotepadReferences(
  deps: PassiveSubscriptionContextDependencies | undefined,
  recipient: SubscriptionRecipient,
  references: readonly NotepadDeliveryRecord[],
  ownReceipt: (finish: () => Promise<void>) => void,
) {
  const enabled =
    references.length > 0 &&
    deps?.recordAcceptedNotepadReferences !== undefined;
  let finalized = false;
  const receipt = createRequiredInputReceipt(async () => {
    if (!references.length) return;
    await deps?.recordAcceptedNotepadReferences?.(recipient, references);
  });
  const finish = () => {
    finalized = true;
    return receipt.finish();
  };
  if (enabled) ownReceipt(finish);
  return {
    ...receipt,
    finish,
    markDispatched() {
      if (enabled && finalized)
        throw new Error("Accepted notepad reference input already finalized");
    },
  };
}

export interface PassiveSubscriptionContext {
  block: string | null;
  onInputAccepted(): Promise<void>;
  markDispatched(): void;
  markDispatchFailure(error: unknown): void;
  finish(): Promise<void>;
}

export async function preparePassiveSubscriptionContext(
  deps: PassiveSubscriptionContextDependencies | undefined,
  input: {
    recipient: SubscriptionRecipient;
    attemptId: string;
    eligible: boolean;
    providedNotepadContext?: readonly NotepadDeliveryRecord[];
  },
  ownReceipt: (finish: () => Promise<void>) => void,
): Promise<PassiveSubscriptionContext> {
  const inert: PassiveSubscriptionContext = {
    block: null,
    onInputAccepted: async () => {},
    markDispatched() {},
    markDispatchFailure() {},
    finish: async () => {},
  };
  if (!deps || !input.eligible) return inert;
  await deps.synchronizeInvolvement(input.recipient);
  const briefing = await deps.prepareBriefing({
    recipient: input.recipient,
    attemptId: input.attemptId,
    providedNotepadContext: input.providedNotepadContext,
  });
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
