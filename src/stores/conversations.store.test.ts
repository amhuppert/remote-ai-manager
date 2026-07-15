import { describe, it, expect, beforeEach } from "vitest";
import { _useConversationsStore } from "./conversations.store";

function resetStore() {
  _useConversationsStore.setState({
    showArchived: false,
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
});
