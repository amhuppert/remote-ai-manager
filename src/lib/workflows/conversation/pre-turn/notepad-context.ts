import { expandNotepadRefsForAgent } from "@/lib/notepads/injection";
import type {
  NotepadDeliveryRecord,
  PreparedNotepadChangeNotice,
} from "@/lib/notepads/change-notices";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationActorDependencies } from "../actor-dependencies";
import type { PreparedTurnContribution } from "../turn-context";

type NotepadContextDependencies = {
  context: Pick<
    ConversationActorDependencies["context"],
    "readNotepadForInjection" | "prepareNotepadChangeNotice"
  >;
  effects: Pick<
    ConversationActorDependencies["effects"],
    "recordNotepadDeliveries" | "settleNotepadChangeNotice"
  >;
  log: ConversationActorDependencies["log"];
};

export async function prepareNotepadContext(
  deps: NotepadContextDependencies,
  input: { conversationId: string; promptText: string },
): Promise<PreparedTurnContribution & { text: string }> {
  let text = input.promptText;
  let references: readonly NotepadDeliveryRecord[] = [];
  // Notepad references expand to full canonical content for the agent only.
  // The executor captures the unexpanded transcript first, so the chip still
  // renders in history. A read failure preserves the original reference.
  try {
    const expansion = await expandNotepadRefsForAgent(text, {
      readForInjection: deps.context.readNotepadForInjection,
    });
    text = expansion.text;
    references = expansion.delivered.map(({ id, revision, openComments }) => ({
      notepadId: id,
      revision,
      openComments: { ...openComments },
    }));
    if (text !== input.promptText)
      deps.log.info("prompt.notepad_refs_expanded", {
        conversationId: input.conversationId,
        requestLength: input.promptText.length,
        expandedLength: text.length,
      });
  } catch (error) {
    deps.log.warn("prompt.notepad_expansion_failed", {
      conversationId: input.conversationId,
      error: getErrorMessage(error),
    });
  }
  let notice: PreparedNotepadChangeNotice | null = null;
  try {
    notice = await deps.context.prepareNotepadChangeNotice(
      input.conversationId,
      references,
    );
    if (notice.block)
      deps.log.info("prompt.notepad_change_notice_prepended", {
        conversationId: input.conversationId,
        count: notice.advances.length,
      });
  } catch (error) {
    deps.log.warn("prompt.notepad_change_notice_failed", {
      conversationId: input.conversationId,
      error: getErrorMessage(error),
    });
  }
  let acceptance: Promise<void> | undefined;
  return {
    text,
    block: notice?.block ?? null,
    onInputAccepted() {
      acceptance ??= (async () => {
        // The repository replaces watermarks, so reference receipts precede the
        // notice advances that may carry a later revision or comment marker.
        if (references.length) {
          try {
            await deps.effects.recordNotepadDeliveries({
              conversationId: input.conversationId,
              notepads: references,
            });
            deps.log.info("prompt.notepad_delivery_settled", {
              conversationId: input.conversationId,
              count: references.length,
            });
          } catch (error) {
            deps.log.warn("prompt.notepad_delivery_record_failed", {
              conversationId: input.conversationId,
              count: references.length,
              error: getErrorMessage(error),
            });
          }
        }
        // Watermarks advance only on acceptance; preparation and dispatch
        // failures leave the notice eligible for the next message (D17).
        // Recording each advisory receipt independently preserves deliveries
        // the agent read even when a neighbouring receipt cannot be committed.
        if (notice === null) return;
        try {
          await deps.effects.settleNotepadChangeNotice(notice);
          deps.log.info("prompt.notepad_change_notice_settled", {
            conversationId: input.conversationId,
            count: notice.advances.length,
          });
        } catch (error) {
          deps.log.warn("prompt.notepad_change_notice_settle_failed", {
            conversationId: input.conversationId,
            error: getErrorMessage(error),
          });
        }
      })();
      return acceptance;
    },
  };
}
