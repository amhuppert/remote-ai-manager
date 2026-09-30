// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CommandIndicator from "./CommandIndicator";
import { renderWithQuery } from "@/test/component-mocks";
import { buildNotepadRefXml } from "@/lib/notepads/references";

// All arguments use the canonical compact Markdown adapter, including a
// one-line command. This keeps references and long arguments readable.
function compactRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-markdown-intent="compact"]',
  );
}

describe("CommandIndicator", () => {
  it("renders one-line arguments in a labeled, complete argument body", async () => {
    const { container } = render(
      <CommandIndicator name="/collab" args="short single-line argument" />,
    );
    expect(screen.getByText("/collab")).toBeDefined();
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    await waitFor(() => expect(compactRoot(container)).not.toBeNull());
    expect(screen.getByText("short single-line argument")).toBeInTheDocument();
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

  it("shows collab arguments as readable content with a notepad reference chip", async () => {
    const ref = buildNotepadRefXml({
      notepadId: "np-vision",
      name: "Command Center Vision",
      scope: "project",
      projectName: "command-center",
    });
    const { container } = renderWithQuery(
      <CommandIndicator name="/collab" args={`${ref} Review this plan.`} />,
    );

    expect(await screen.findByText("Arguments")).toBeInTheDocument();
    expect(await screen.findByTestId("notepad-ref-chip")).toHaveTextContent(
      "Command Center Vision",
    );
    expect(container.textContent).toContain("Review this plan.");
    expect(container.textContent).not.toContain("<notepad-ref");
  });
});
