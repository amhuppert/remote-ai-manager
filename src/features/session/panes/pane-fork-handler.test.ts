import { describe, expect, it, vi } from "vitest";
import { createPaneForkHandler } from "./pane-fork-handler";

describe("createPaneForkHandler", () => {
  it("opens the forked conversation in the working set on success", async () => {
    const openInWorkingSet = vi.fn();
    const failPrompt = vi.fn();
    const handler = createPaneForkHandler({
      conversationId: "conv-1",
      forkConversation: async ({ conversationId, messageIndex }) => {
        expect(conversationId).toBe("conv-1");
        expect(messageIndex).toBe(3);
        return { conversationId: "conv-forked" };
      },
      openInWorkingSet,
      failPrompt,
    });

    await handler(3);

    expect(openInWorkingSet).toHaveBeenCalledWith("conv-forked");
    expect(failPrompt).not.toHaveBeenCalled();
  });

  it("surfaces a failure on the conversation's keyed error state", async () => {
    const openInWorkingSet = vi.fn();
    const failPrompt = vi.fn();
    const handler = createPaneForkHandler({
      conversationId: "conv-1",
      forkConversation: async () => {
        throw new Error("fork exploded");
      },
      openInWorkingSet,
      failPrompt,
    });

    await handler(0);

    expect(openInWorkingSet).not.toHaveBeenCalled();
    expect(failPrompt).toHaveBeenCalledWith("conv-1", "fork exploded");
  });
});
