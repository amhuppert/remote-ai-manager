// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CommandIndicator from "./CommandIndicator";

// Behavior, not appearance: the inline-vs-expanded split is keyed on whether
// `args` is multi-line. Expanded arguments render through the canonical
// `CompactMarkdown` adapter (marked by `data-markdown-intent="compact"`); the
// collapsed and no-args modes render plain text with no Markdown surface. The
// legacy `.command-indicator__body` hook and its descendant CSS are gone.
function compactRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-markdown-intent="compact"]',
  );
}

describe("CommandIndicator", () => {
  it("renders the command name and args inline when args has no newline", () => {
    const { container } = render(
      <CommandIndicator name="/collab" args="short single-line argument" />,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    expect(screen.getByText("short single-line argument")).toBeDefined();
    expect(compactRoot(container)).toBeNull();
    expect(container.querySelector(".command-indicator__body")).toBeNull();
  });

  it("renders just the command name when args is null", () => {
    const { container } = render(
      <CommandIndicator name="/compact" args={null} />,
    );
    expect(screen.getByText("/compact")).toBeDefined();
    expect(compactRoot(container)).toBeNull();
    expect(container.querySelector(".command-indicator__body")).toBeNull();
  });

  it("renders expanded arguments through the compact canonical adapter when args contains a newline", async () => {
    const args = "Line one.\n\n**Bold change** and more details.";
    const { container } = render(
      <CommandIndicator name="/collab" args={args} />,
    );
    expect(screen.getByText("/collab")).toBeDefined();

    // The renderer is loaded behind one dynamic import — wait for the canonical
    // compact root to replace the streaming fallback.
    await waitFor(() => expect(compactRoot(container)).not.toBeNull(), {
      timeout: 15000,
    });

    expect(container.querySelector(".command-indicator__body")).toBeNull();
    expect(screen.getByText("Bold change").tagName).toBe("STRONG");
  });

  it("renders the full GFM/safety contract in expanded arguments", async () => {
    const args = [
      "Uses ~~legacy~~ **canonical** rendering.",
      "",
      '<button data-injected onclick="alert(1)">danger</button>',
    ].join("\n");
    const { container } = render(
      <CommandIndicator name="/collab" args={args} />,
    );

    await waitFor(() => expect(compactRoot(container)).not.toBeNull(), {
      timeout: 15000,
    });

    // GFM strikethrough the collapsed inline path could never produce.
    expect(screen.getByText("legacy").tagName).toBe("DEL");
    // Raw HTML is shown as text, never executed.
    expect(container.querySelector("button[data-injected]")).toBeNull();
    expect(compactRoot(container)?.textContent).toContain(
      "<button data-injected",
    );
  });
});
