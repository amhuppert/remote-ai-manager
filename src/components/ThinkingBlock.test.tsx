// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ThinkingBlock from "./ThinkingBlock";

function markdownRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-markdown-intent="message"]',
  );
}

describe("ThinkingBlock", () => {
  // The canonical adapter is lazy-loaded, so allow for the dynamic import under
  // parallel-suite load (mirrors MessageContent.test.tsx's budget).
  const LOAD_TIMEOUT = { timeout: 5000 } as const;

  it("renders the reasoning body through the canonical message adapter", async () => {
    const { container } = render(
      <ThinkingBlock text="Check **the selector** and the `cn()` helper." />,
    );

    await waitFor(() => {
      expect(markdownRoot(container)).not.toBeNull();
    }, LOAD_TIMEOUT);
    const strong = await screen.findByText("the selector", {}, LOAD_TIMEOUT);
    expect(strong.tagName).toBe("STRONG");
    expect(strong.closest('[data-markdown-intent="message"]')).not.toBeNull();
    const code = screen.getByText("cn()");
    expect(code.tagName).toBe("CODE");
  });

  it("keeps the reasoning body inside the italic tone host", async () => {
    const { container } = render(<ThinkingBlock text="Reasoning prose." />);

    await waitFor(() => {
      expect(markdownRoot(container)).not.toBeNull();
    }, LOAD_TIMEOUT);
    // The disclosure body is the tone host: the canonical adapter renders
    // directly inside it, and it still carries the italic "inner voice" tone.
    const toneHost = markdownRoot(container)!.parentElement;
    expect(toneHost?.className).toContain("italic");
  });

  it("preserves the disclosure: toggling hides the reasoning body", async () => {
    const { container } = render(<ThinkingBlock text="Commanded thought." />);

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(markdownRoot(container)).not.toBeNull();
    }, LOAD_TIMEOUT);
    expect(screen.getByText("Commanded thought.")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Collapsing removes the reasoning body (and its canonical adapter) entirely.
    expect(markdownRoot(container)).toBeNull();
    expect(screen.queryByText("Commanded thought.")).not.toBeInTheDocument();
  });

  it("renders a redacted block as a label-only indicator with no toggle or body", () => {
    render(<ThinkingBlock text="" redacted />);

    expect(screen.getByText("Internal reasoning")).toBeInTheDocument();
    expect(screen.getByText("— hidden")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders code, tables, and long unbroken content through the canonical adapter", async () => {
    const longToken = "a".repeat(120);
    const body = [
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "| Surface | Intent |",
      "| --- | --- |",
      "| Thinking | message |",
      "",
      longToken,
    ].join("\n");
    const { container } = render(<ThinkingBlock text={body} />);

    const root = await waitFor(() => {
      const found = markdownRoot(container);
      expect(found).not.toBeNull();
      return found!;
    }, LOAD_TIMEOUT);

    expect(root.querySelector("[data-markdown-code-block]")).not.toBeNull();
    expect(
      screen.getByRole("region", { name: "Scrollable table" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Surface" }),
    ).toBeInTheDocument();
    expect(root.textContent).toContain(longToken);
  });
});
