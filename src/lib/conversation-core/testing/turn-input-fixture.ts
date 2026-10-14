import type { TurnInputDependencies } from "../turn-input";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
export function turnInputFixture(): TurnInputDependencies {
  return {
    context: {
      getLiveTicketBlock: async () => null,
      getMemoryIndexBlock: async () => null,
      readLiveReference: async () => null,
      readNotepadForInjection: async () => null,
    },
    effects: {
      recordNotepadDeliveries: async () => {},
      recordMemoryIndexDeliveries: async () => {},
      prepareRuntimeLossNotice: async () => ({
        block: null,
        async onInputAccepted() {},
        async finish() {},
      }),
      mutateConversation: async () => {},
    },
    debug: {
      getDebugLogUrl: (id) =>
        `http://localhost/api/debug-logs?conversationId=${id}`,
    },
    log: createCapturingLogger(),
  };
}
