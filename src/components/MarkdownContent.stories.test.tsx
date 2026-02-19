// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./MarkdownContent.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Paragraph, CodeBlock, MixedContent, LongContent } =
  composeStories(stories);

describe("MarkdownContent stories", () => {
  it("Paragraph renders inline formatting", async () => {
    await Paragraph.run();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("italic")).toBeInTheDocument();
    expect(screen.getByText("inline code")).toBeInTheDocument();
  });

  it("CodeBlock renders syntax-highlighted TypeScript", async () => {
    await CodeBlock.run();
    // Syntax highlighter splits tokens into spans; check full document text
    expect(document.body.textContent).toContain("SessionState");
    expect(document.body.textContent).toContain("createSession");
  });

  it("MixedContent renders headings, lists, and code", async () => {
    await MixedContent.run();
    expect(screen.getByText("Session Summary")).toBeInTheDocument();
    // Code block text is split across token spans
    expect(document.body.textContent).toContain("42 tests passed");
  });

  it("LongContent renders full document structure", async () => {
    await LongContent.run();
    expect(screen.getByText("Architecture Overview")).toBeInTheDocument();
    expect(screen.getByText("Key Components")).toBeInTheDocument();
  });
});
