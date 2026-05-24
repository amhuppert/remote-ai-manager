import { describe, it, expect } from "vitest";
import { computeSendButtonState } from "./PromptComposer";

const base = {
  promptText: "hello",
  pendingImageCount: 0,
  sending: false,
  conversationId: "c1",
  isReadOnly: false,
  isRecording: false,
};

describe("computeSendButtonState", () => {
  it("enables send when prompt has text", () => {
    expect(computeSendButtonState(base)).toEqual({
      disabled: false,
      title: "Send prompt",
    });
  });

  it("disables and shows read-only title when read-only", () => {
    expect(computeSendButtonState({ ...base, isReadOnly: true })).toEqual({
      disabled: true,
      title: "Session is read-only",
    });
  });

  it("queues message when sending with an existing conversation", () => {
    expect(computeSendButtonState({ ...base, sending: true })).toEqual({
      disabled: false,
      title: "Queue message",
    });
  });

  it("marks session busy when sending without conversationId", () => {
    expect(
      computeSendButtonState({ ...base, sending: true, conversationId: "" }),
    ).toEqual({ disabled: true, title: "Session is busy" });
  });

  it("disables when no text and no images", () => {
    expect(computeSendButtonState({ ...base, promptText: "  " }).disabled).toBe(
      true,
    );
  });

  it("enables when prompt is empty but images are pending", () => {
    expect(
      computeSendButtonState({
        ...base,
        promptText: "",
        pendingImageCount: 1,
      }).disabled,
    ).toBe(false);
  });

  it("disables when recording (the click should stop recording first)", () => {
    expect(
      computeSendButtonState({ ...base, isRecording: true }).disabled,
    ).toBe(true);
  });
});
