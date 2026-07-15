import { describe, expect, it } from "vitest";
import {
  computeComposerCollapsed,
  computeComposerIdle,
} from "@/components/session/prompt/composer-collapse";

const IDLE_BASE = {
  promptText: "",
  pendingImageCount: 0,
  isRecording: false,
  hasCollabChip: false,
  inputInert: false,
};

describe("computeComposerIdle", () => {
  it("is idle when empty, no images, not recording, no collab chip", () => {
    expect(computeComposerIdle(IDLE_BASE)).toBe(true);
  });

  it("treats whitespace-only text as idle", () => {
    expect(computeComposerIdle({ ...IDLE_BASE, promptText: "   \n" })).toBe(
      true,
    );
  });

  it("is not idle with real text", () => {
    expect(computeComposerIdle({ ...IDLE_BASE, promptText: "hi" })).toBe(false);
  });

  it("is not idle with a pending image", () => {
    expect(computeComposerIdle({ ...IDLE_BASE, pendingImageCount: 1 })).toBe(
      false,
    );
  });

  it("is not idle while recording", () => {
    expect(computeComposerIdle({ ...IDLE_BASE, isRecording: true })).toBe(
      false,
    );
  });

  it("is not idle while composing a /collab command", () => {
    expect(computeComposerIdle({ ...IDLE_BASE, hasCollabChip: true })).toBe(
      false,
    );
  });

  it("is always idle when the editor is inert, even with staged content", () => {
    expect(
      computeComposerIdle({
        ...IDLE_BASE,
        promptText: "ignored",
        pendingImageCount: 3,
        inputInert: true,
      }),
    ).toBe(true);
  });
});

const COLLAPSE_BASE = {
  isMobile: true,
  idle: true,
  composerFocused: false,
  expandLatch: false,
};

describe("computeComposerCollapsed", () => {
  it("collapses an idle, unfocused mobile composer", () => {
    expect(computeComposerCollapsed(COLLAPSE_BASE)).toBe(true);
  });

  it("never collapses on desktop", () => {
    expect(
      computeComposerCollapsed({ ...COLLAPSE_BASE, isMobile: false }),
    ).toBe(false);
  });

  it("stays expanded while focused", () => {
    expect(
      computeComposerCollapsed({ ...COLLAPSE_BASE, composerFocused: true }),
    ).toBe(false);
  });

  it("stays expanded while the expand latch is held", () => {
    expect(
      computeComposerCollapsed({ ...COLLAPSE_BASE, expandLatch: true }),
    ).toBe(false);
  });

  it("stays expanded when there is content (not idle)", () => {
    expect(computeComposerCollapsed({ ...COLLAPSE_BASE, idle: false })).toBe(
      false,
    );
  });
});
