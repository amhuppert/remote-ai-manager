// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import * as stories from "./ConversationSidebarHeader.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

const { Empty, Populated, NeedsFilterActive } = composeStories(stories);

describe("ConversationSidebarHeader stories", () => {
  it("Empty renders a search input with no value", async () => {
    await Empty.run();
    const input = screen.getByLabelText("Search conversations");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");
    expect((input as HTMLInputElement).type).toBe("text");
    expect(screen.queryByText("\u2318K")).toBeNull();
  });

  it("Populated renders the initial filter value", async () => {
    await Populated.run();
    const input = screen.getByLabelText(
      "Search conversations",
    ) as HTMLInputElement;
    expect(input.value).toBe("validate");
    expect(screen.getAllByLabelText("Clear search")).toHaveLength(1);
  });

  it("NeedsFilterActive shows the Needs filter active with its count", async () => {
    await NeedsFilterActive.run();
    const button = screen.getByRole("tab", { name: /needs 3/i });
    expect(button.className).toContain("active");
    expect(button).toHaveTextContent("3");
  });

  it("does not render density controls", async () => {
    await Empty.run();
    expect(screen.queryByRole("button", { name: "Comfortable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });
});
