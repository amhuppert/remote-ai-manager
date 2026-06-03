import { describe, it, expect } from "vitest";
import { presentConversationStatus, isLiveStatus } from "./conversation-status";

describe("presentConversationStatus", () => {
  it("maps running to a cyan dot + running badge", () => {
    expect(presentConversationStatus("running")).toEqual({
      dotClass: "cyan",
      label: "Running",
      badgeStatus: "running",
    });
  });

  it("maps awaiting and waiting_for_input to amber + awaiting badge", () => {
    expect(presentConversationStatus("awaiting").dotClass).toBe("amber");
    expect(presentConversationStatus("awaiting").badgeStatus).toBe("awaiting");
    expect(presentConversationStatus("waiting_for_input")).toEqual({
      dotClass: "amber",
      label: "Waiting for input",
      badgeStatus: "awaiting",
    });
  });

  it("renders no indicator for the resting 'new' status", () => {
    expect(presentConversationStatus("new")).toEqual({
      dotClass: null,
      label: null,
      badgeStatus: null,
    });
  });
});

describe("isLiveStatus", () => {
  it("is true for running/awaiting/waiting_for_input and false for new", () => {
    expect(isLiveStatus("running")).toBe(true);
    expect(isLiveStatus("awaiting")).toBe(true);
    expect(isLiveStatus("waiting_for_input")).toBe(true);
    expect(isLiveStatus("new")).toBe(false);
  });
});
