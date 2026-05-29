import { describe, expect, it, vi } from "vitest";
import { composeStories } from "@storybook/react";
import * as stories from "./PeekPopover.stories";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  New,
  Running,
  Awaiting,
  WaitingForInputStructuredSingleSelect,
  WaitingForInputStructuredMultiSelectOther,
  WaitingForInputFallbackBanner,
} = composeStories(stories);

describe("PeekPopover stories", () => {
  it("exports the requested six story states", () => {
    expect(New).toBeDefined();
    expect(Running).toBeDefined();
    expect(Awaiting).toBeDefined();
    expect(WaitingForInputStructuredSingleSelect).toBeDefined();
    expect(WaitingForInputStructuredMultiSelectOther).toBeDefined();
    expect(WaitingForInputFallbackBanner).toBeDefined();
  });
});
