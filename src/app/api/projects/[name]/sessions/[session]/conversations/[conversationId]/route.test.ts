import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("session conversation route wiring", () => {
  it("exports the production delete handler", async () => {
    const source = await readFile(
      new URL("./route.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("deleteSessionConversation as DELETE");
  });
});
