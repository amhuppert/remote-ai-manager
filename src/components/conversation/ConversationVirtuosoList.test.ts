import { describe, expect, it } from "vitest";
import {
  resolveConversationFollowOutput,
  shouldStopConversationFollow,
} from "./ConversationVirtuosoList";

describe("resolveConversationFollowOutput", () => {
  it("follows instantly while bottom following is engaged", () => {
    expect(resolveConversationFollowOutput(true)).toBe("auto");
    expect(resolveConversationFollowOutput(false)).toBe(false);
  });
});

it("pauses following for upward scrolling, while preserving it across resizing", () => {
  expect(shouldStopConversationFollow(1400, 1100, 2000, 2000, 600)).toBe(true);
  expect(shouldStopConversationFollow(1400, 1400, 2000, 2200, 600)).toBe(false);
  expect(shouldStopConversationFollow(1400, 1300, 2000, 1900, 600)).toBe(false);
  expect(shouldStopConversationFollow(1400, 1398, 2000, 2000, 600)).toBe(false);
});
