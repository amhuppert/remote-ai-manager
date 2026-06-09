import { describe, expect, it } from "vitest";
import type { ConversationBackendEvent } from "./conversation";

describe("ConversationBackendEvent", () => {
  it("includes an input_accepted lifecycle event", () => {
    const event: ConversationBackendEvent = { type: "input_accepted" };

    expect(event.type).toBe("input_accepted");
  });

  it("narrows the existing lifecycle members alongside input_accepted", () => {
    const events: ConversationBackendEvent[] = [
      { type: "input_accepted" },
      { type: "external_turn_started" },
      { type: "error", message: "boom" },
    ];

    const seen = events.map((event) => {
      switch (event.type) {
        case "input_accepted":
          return "accepted";
        case "external_turn_started":
          return "started";
        case "error":
          return event.message;
        default:
          return "other";
      }
    });

    expect(seen).toEqual(["accepted", "started", "boom"]);
  });
});
