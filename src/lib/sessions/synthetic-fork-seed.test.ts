import { describe, expect, it } from "vitest";
import { buildSyntheticForkSeed } from "./synthetic-fork-seed";

describe("synthetic fork history bounds", () => {
  it("fits the persisted 24000 character bound while retaining the anchor", async () => {
    const seed = await buildSyntheticForkSeed("/source", 1, {
      readConversationMessages: async () => [
        { role: "user", content: [{ type: "text", text: "x".repeat(30000) }] },
        { role: "assistant", content: [{ type: "text", text: "anchor" }] },
      ],
    });
    expect(seed).toContain("anchor");
    expect(seed?.length).toBeLessThanOrEqual(24000);
  });
  it("refuses history with no dialogue text", async () => {
    expect(
      await buildSyntheticForkSeed("/source", 0, {
        readConversationMessages: async () => [
          { role: "notice", content: [{ type: "text", text: "notice" }] },
        ],
      }),
    ).toBeNull();
  });
});
