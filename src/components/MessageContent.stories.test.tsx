// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./MessageContent.stories";

beforeAll(storybookAnnotations.beforeAll);

const { TextOnly, WithToolUse, MultipleBlocks, ToolUseWithoutInput } =
  composeStories(stories);

describe("MessageContent stories", () => {
  it("TextOnly renders markdown text", async () => {
    await TextOnly.run();
    // The canonical Markdown adapter defers its renderer — wait for first paint.
    expect(
      await screen.findByText(/refactor the authentication module/),
    ).toBeInTheDocument();
  });

  it("WithToolUse renders tool-use indicator", async () => {
    await WithToolUse.run();
    const toggle = screen.getByRole("button", { name: /1 tool use/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.queryByText("/src/lib/auth.ts")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("/src/lib/auth.ts")).toBeInTheDocument();
  });

  it("MultipleBlocks renders text and tool-use blocks, skips tool_result", async () => {
    await MultipleBlocks.run();
    expect(
      await screen.findByText(/update the session manager/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Read")).toHaveLength(1);
    expect(screen.getAllByText("Write")).toHaveLength(1);
    // tool_result should not be rendered
    expect(screen.queryByText("file contents...")).toBeNull();
  });

  it("ToolUseWithoutInput renders tool name without context", async () => {
    await ToolUseWithoutInput.run();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });
});
