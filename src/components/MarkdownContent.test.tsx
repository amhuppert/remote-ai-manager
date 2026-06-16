// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import MarkdownContent from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders fenced code blocks with syntax-highlighted tokens", async () => {
    const md =
      '```typescript\nfunction hello(): string {\n  return "world";\n}\n```';
    const { container } = render(<MarkdownContent content={md} />);

    // Language module + style load lazily; wait for highlighted tokens to appear.
    await waitFor(
      () => {
        const tokenSpans = container.querySelectorAll("span");
        const allClasses = Array.from(tokenSpans)
          .map((s) => s.className)
          .join(" ");
        expect(allClasses).toContain("token");
      },
      { timeout: 5000 },
    );

    const tokenSpans = container.querySelectorAll("span");
    const hasKeyword = Array.from(tokenSpans).some(
      (span) =>
        span.className.includes("keyword") || span.textContent === "function",
    );
    expect(hasKeyword).toBe(true);
  });

  it("renders inline code without SyntaxHighlighter", () => {
    const md = "Use `const x = 1` in your code";
    const { container } = render(<MarkdownContent content={md} />);

    const inlineCode = container.querySelector("code");
    expect(inlineCode).not.toBeNull();
    expect(inlineCode?.textContent).toBe("const x = 1");
    // Should NOT have token spans inside inline code
    const tokenSpans = inlineCode?.querySelectorAll("span.token");
    expect(tokenSpans?.length ?? 0).toBe(0);
  });

  it("renders a copy button for fenced code blocks with a language tag", () => {
    const md =
      '```typescript\nfunction hello(): string {\n  return "world";\n}\n```';
    const { container } = render(<MarkdownContent content={md} />);

    const copyBtn = container.querySelector(".code-block-copy-btn");
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.getAttribute("title")).toBe("Copy code");
  });

  it("renders a copy button for fenced code blocks without a language tag", () => {
    const md = "```\nconst x = 1;\nconst y = 2;\n```";
    const { container } = render(<MarkdownContent content={md} />);

    const copyBtn = container.querySelector(".code-block-copy-btn");
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.getAttribute("title")).toBe("Copy code");
  });

  it("does not render a copy button for inline code", () => {
    const md = "Use `const x = 1` in your code";
    const { container } = render(<MarkdownContent content={md} />);

    const copyBtn = container.querySelector(".code-block-copy-btn");
    expect(copyBtn).toBeNull();
  });

  it("renders links that open in a new tab with a safe rel", () => {
    const md = "See [Example](https://example.com) for details.";
    const { container } = render(<MarkdownContent content={md} />);

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    const rel = link?.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("renders mermaid code blocks with MermaidDiagram component", async () => {
    const md = "```mermaid\ngraph LR\n    A --> B\n```";
    const { container } = render(<MarkdownContent content={md} />);

    // MermaidDiagram is loaded via next/dynamic — wait for it to mount.
    await waitFor(() => {
      const mermaidDiv = container.querySelector(".mermaid-diagram");
      expect(mermaidDiv).not.toBeNull();
    });

    // Should NOT have syntax highlighter tokens
    const tokenSpans = container.querySelectorAll("span.token");
    expect(tokenSpans.length).toBe(0);
  });
});
