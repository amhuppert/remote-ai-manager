// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./LayoutSwitcher.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Conversation, Default, Split, Diff } = composeStories(stories);

function activeButton(): HTMLElement | null {
  return (
    screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-active") === "true") ?? null
  );
}

describe("LayoutSwitcher stories", () => {
  it("Conversation highlights the conversation-only button", async () => {
    await Conversation.run();
    expect(activeButton()?.getAttribute("data-tooltip")).toBe(
      "Conversation only",
    );
  });

  it("Default highlights the default-split button", async () => {
    await Default.run();
    expect(activeButton()?.getAttribute("data-tooltip")).toBe(
      "Conversation + Diff sidebar",
    );
  });

  it("Split highlights the 50/50 button", async () => {
    await Split.run();
    expect(activeButton()?.getAttribute("data-tooltip")).toBe("Split 50/50");
  });

  it("Diff highlights the diff-only button", async () => {
    await Diff.run();
    expect(activeButton()?.getAttribute("data-tooltip")).toBe("Diff only");
  });
});
