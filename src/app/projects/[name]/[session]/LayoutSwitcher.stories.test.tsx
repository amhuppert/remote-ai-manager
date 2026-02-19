// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./LayoutSwitcher.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Conversation, Default, Split, Diff } = composeStories(stories);

describe("LayoutSwitcher stories", () => {
  it("Conversation highlights the conversation-only button", async () => {
    await Conversation.run();
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]!.className).toContain("active");
  });

  it("Default highlights the default-split button", async () => {
    await Default.run();
    const buttons = screen.getAllByRole("button");
    expect(buttons[1]!.className).toContain("active");
  });

  it("Split highlights the 50/50 button", async () => {
    await Split.run();
    const buttons = screen.getAllByRole("button");
    expect(buttons[2]!.className).toContain("active");
  });

  it("Diff highlights the diff-only button", async () => {
    await Diff.run();
    const buttons = screen.getAllByRole("button");
    expect(buttons[3]!.className).toContain("active");
  });
});
