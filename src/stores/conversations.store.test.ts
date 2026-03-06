import { describe, it, expect, beforeEach } from "vitest";
import { _useConversationsStore } from "./conversations.store";

function resetStore() {
  _useConversationsStore.setState({
    showArchived: false,
    deleteTargetId: null,
  });
}

describe("conversations.store", () => {
  beforeEach(resetStore);

  // -----------------------------------------------------------------------
  // showArchived
  // -----------------------------------------------------------------------

  it("starts with showArchived = false", () => {
    expect(_useConversationsStore.getState().showArchived).toBe(false);
  });

  it("toggleArchived flips the value", () => {
    _useConversationsStore.getState().toggleArchived();
    expect(_useConversationsStore.getState().showArchived).toBe(true);

    _useConversationsStore.getState().toggleArchived();
    expect(_useConversationsStore.getState().showArchived).toBe(false);
  });

  // -----------------------------------------------------------------------
  // deleteTargetId
  // -----------------------------------------------------------------------

  it("starts with deleteTargetId = null", () => {
    expect(_useConversationsStore.getState().deleteTargetId).toBeNull();
  });

  it("requestDeleteConversation sets the target id", () => {
    _useConversationsStore.getState().requestDeleteConversation("conv-123");
    expect(_useConversationsStore.getState().deleteTargetId).toBe("conv-123");
  });

  it("cancelDeleteConversation clears the target id", () => {
    _useConversationsStore.getState().requestDeleteConversation("conv-123");
    _useConversationsStore.getState().cancelDeleteConversation();
    expect(_useConversationsStore.getState().deleteTargetId).toBeNull();
  });

  it("requesting delete for a different conversation replaces the target", () => {
    _useConversationsStore.getState().requestDeleteConversation("conv-1");
    _useConversationsStore.getState().requestDeleteConversation("conv-2");
    expect(_useConversationsStore.getState().deleteTargetId).toBe("conv-2");
  });
});
