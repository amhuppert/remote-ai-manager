// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./MessageContent.stories";

beforeAll(storybookAnnotations.beforeAll);

const { TextOnly, WithToolUse, MultipleBlocks, ToolUseWithoutInput } =
  composeStories(stories);

describe("MessageContent stories", () => {
  it("TextOnly renders markdown text", async () => {
    await TextOnly.run();
    // MarkdownContent is loaded via next/dynamic — wait for first paint.
    expect(
      await screen.findByText(/refactor the authentication module/),
    ).toBeInTheDocument();
  });

  it("WithToolUse renders tool-use indicator", async () => {
    await WithToolUse.run();
    expect(screen.getByText("Read")).toBeInTheDocument();
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
