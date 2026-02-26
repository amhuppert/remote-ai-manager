// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownContent from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders fenced code blocks with syntax-highlighted tokens", () => {
    const md =
      '```typescript\nfunction hello(): string {\n  return "world";\n}\n```';
    const { container } = render(<MarkdownContent content={md} />);

    // SyntaxHighlighter wraps code in a div (PreTag="div") with spans for tokens
    const tokenSpans = container.querySelectorAll("span");
    const hasKeyword = Array.from(tokenSpans).some(
      (span) =>
        span.className.includes("keyword") || span.textContent === "function",
    );
    expect(hasKeyword).toBe(true);

    // Verify the language-specific tokens exist (not just plain text)
    const allClasses = Array.from(tokenSpans)
      .map((s) => s.className)
      .join(" ");
    expect(allClasses).toContain("token");
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

  it("renders mermaid code blocks with MermaidDiagram component", () => {
    const md = "```mermaid\ngraph LR\n    A --> B\n```";
    const { container } = render(<MarkdownContent content={md} />);

    // Should render a MermaidDiagram container, not syntax highlighter tokens
    const mermaidDiv = container.querySelector(".mermaid-diagram");
    expect(mermaidDiv).not.toBeNull();

    // Should NOT have syntax highlighter tokens
    const tokenSpans = container.querySelectorAll("span.token");
    expect(tokenSpans.length).toBe(0);
  });
});
