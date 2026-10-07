import { expandNotepadRefsForAgent } from "@/lib/notepads/injection";
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationTurnDependencies } from "@/lib/conversation-core/turn/dependencies";
import type { PreparedTurnContribution } from "@/lib/conversation-core/turn/turn-context";
import { createRequiredInputReceipt } from "./required-input-receipt";

type NotepadContextDependencies = {
  context: Pick<
    ConversationTurnDependencies["context"],
    "readNotepadForInjection"
  >;
  effects: Pick<
    ConversationTurnDependencies["effects"],
    "recordNotepadDeliveries"
  >;
  log: ConversationTurnDependencies["log"];
};

export async function prepareNotepadContext(
  deps: NotepadContextDependencies,
  input: { conversationId: string; promptText: string },
): Promise<
  PreparedTurnContribution & {
    text: string;
    references: readonly NotepadDeliveryRecord[];
    finish(): Promise<void>;
    markDispatched(): void;
  }
> {
  let text = input.promptText;
  let references: readonly NotepadDeliveryRecord[] = [];
  try {
    const expansion = await expandNotepadRefsForAgent(text, {
      readForInjection: deps.context.readNotepadForInjection,
    });
    text = expansion.text;
    references = expansion.delivered.map(
      ({ id, revision, openComments, commentIds }) => ({
        notepadId: id,
        revision,
        openComments: { ...openComments },
        ...(commentIds === undefined ? {} : { commentIds: [...commentIds] }),
      }),
    );
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
  const receipt = createRequiredInputReceipt(async () => {
    if (!references.length) return;
    await deps.effects.recordNotepadDeliveries({
      conversationId: input.conversationId,
      notepads: references,
    });
  });
  let finalized = false;
  return {
    text,
    references,
    block: null,
    ...receipt,
    finish() {
      finalized = true;
      return receipt.finish();
    },
    markDispatched() {
      if (finalized)
        throw new Error("Notepad source context input already finalized");
    },
  };
}
