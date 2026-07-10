import { describe, expect, it } from "vitest";
import { resolveConversationFollowOutput } from "./ConversationVirtuosoList";

describe("resolveConversationFollowOutput", () => {
  it("follows from Virtuoso's bottom or while a submitted prompt is re-engaging it", () => {
    expect(resolveConversationFollowOutput(true, false)).toBe("smooth");
    expect(resolveConversationFollowOutput(false, true)).toBe("smooth");
    expect(resolveConversationFollowOutput(false, false)).toBe(false);
  });
});
