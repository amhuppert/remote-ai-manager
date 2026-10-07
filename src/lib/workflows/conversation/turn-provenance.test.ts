import { describe, expect, it } from "vitest";
import { conversationTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";

describe("conversation input provenance", () => {
  it("preserves explicit user provenance independently of execution mode", () => {
    const turn = conversationTurnRequestSchema.safeParse({
      promptText: "Read the latest updates",
      inputOrigin: "user",
      autonomous: true,
    });
    expect(turn.success).toBe(true);
    if (turn.success) expect(turn.data).toMatchObject({ inputOrigin: "user" });
  });

  it("does not infer user provenance from a non-autonomous turn", () => {
    const turn = conversationTurnRequestSchema.parse({
      promptText: "Generated continuation",
      autonomous: false,
    });
    expect(turn).not.toHaveProperty("inputOrigin", "user");
  });
});
