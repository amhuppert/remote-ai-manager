import { beforeEach, describe, expect, it } from "vitest";
import { useSessionDetailStore } from "../session-detail.store";

describe("mobile panel navigation", () => {
  beforeEach(() => useSessionDetailStore.getState().resetStore());

  it("selects the matching content when opening a mobile panel", () => {
    useSessionDetailStore.getState().switchMobilePanel("specs");
    expect(useSessionDetailStore.getState()).toMatchObject({
      mobilePanel: "specs",
      rightPaneTab: "specs",
    });
  });

  it("opens compactions in the visible mobile panel", () => {
    useSessionDetailStore.getState().openContextArtifactPanel();
    expect(useSessionDetailStore.getState()).toMatchObject({
      mobilePanel: "artifact",
      rightPaneTab: "artifact",
    });
  });

  it("returns to chat when following a compaction source", () => {
    useSessionDetailStore.getState().switchMobilePanel("docs");
    useSessionDetailStore.getState().requestMessageNav("conversation", 12);
    expect(useSessionDetailStore.getState()).toMatchObject({
      mobilePanel: "chat",
      messageNavRequest: { conversationId: "conversation", messageIndex: 12 },
    });
  });
});
