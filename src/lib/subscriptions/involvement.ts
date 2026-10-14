import type { DurableConversationIdentity } from "@/lib/conversations/provenance";
import { isEligibleSubscriptionRecipient } from "@/lib/conversations/provenance";
import type { NotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import type { NotepadsRepo } from "@/lib/state-store/notepads-repo";
import type { SubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import type { SubscriptionRecipient } from "./schemas";
import type { SubscriptionInvolvement, SubscriptionService } from "./service";
import { notepadInvolvementCursor } from "./notepad-source";
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";

export interface SubscriptionInvolvementDeps {
  readConversation(conversationId: string): DurableConversationIdentity | null;
  watermarks: NotepadDeliveryWatermarksRepo;
  notepads: NotepadsRepo;
  queries: SubscriptionSourceQueriesRepo;
}

export function createSubscriptionInvolvementReader(
  deps: SubscriptionInvolvementDeps,
) {
  return async function discoverInvolvement(
    recipient: SubscriptionRecipient,
  ): Promise<SubscriptionInvolvement[]> {
    const identity = deps.readConversation(recipient.conversationId);
    if (
      !isEligibleSubscriptionRecipient(identity, recipient.projectPath) ||
      identity === null
    )
      return [];
    const involvement: SubscriptionInvolvement[] = [];
    for (const watermark of await deps.watermarks.listForConversation(
      recipient.conversationId,
    )) {
      const notepad = await deps.notepads.find(watermark.notepadId);
      if (
        !notepad ||
        (notepad.scope === "project" &&
          notepad.projectPath !== recipient.projectPath)
      )
        continue;
      involvement.push({
        source: { kind: "notepad", id: watermark.notepadId },
        reason: "Notepad supplied as accepted conversation context",
        initialCursor: notepadInvolvementCursor(watermark),
      });
    }
    for (const ticket of deps.queries.findTicketInvolvement(
      recipient,
      identity.sessionName,
    )) {
      involvement.push({
        source: { kind: "ticket", id: ticket.id },
        reason: "Ticket linked to this conversation or its session",
      });
    }
    for (const spec of deps.queries.findSpecInvolvement(recipient)) {
      involvement.push({
        source: { kind: "spec", id: spec.id },
        reason: "Spec authored or reviewed by this conversation",
      });
    }
    return involvement;
  };
}

export async function synchronizeSubscriptionInvolvement(
  recipient: SubscriptionRecipient,
): Promise<void> {
  const { getSubscriptionService } = await import("./service-factory");
  await getSubscriptionService().list(recipient);
}

/** Acceptance owns these revisions even if a source vanishes before inspection. */
export async function followAcceptedNotepadContext(
  recipient: SubscriptionRecipient,
  references: readonly NotepadDeliveryRecord[],
  service?: SubscriptionService,
): Promise<void> {
  const owner =
    service ?? (await import("./service-factory")).getSubscriptionService();
  for (const reference of references) {
    await owner.autoFollow({
      recipient,
      source: { kind: "notepad", id: reference.notepadId },
      reason: "Notepad supplied as accepted conversation context",
      initialCursor: notepadInvolvementCursor(reference),
    });
  }
}
