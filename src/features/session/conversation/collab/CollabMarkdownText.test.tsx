// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";

function compactRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-markdown-intent="compact"]',
  );
}

describe("CollabMarkdownText", () => {
  it("renders normalized narrative through the compact canonical adapter", async () => {
    // Double-encoded escapes the normalizer must decode before Markdown sees it:
    // literal "\n\n" → a paragraph break, literal "–" → an en dash.
    const { container } = render(
      <CollabMarkdownText content={"First para.\\n\\nUses \\u2013 dashes."} />,
    );

    await waitFor(() => expect(compactRoot(container)).not.toBeNull());

    const paragraphs = compactRoot(container)?.querySelectorAll("p");
    expect(paragraphs?.length).toBe(2);
    // en dash decoded, not left as the literal escape
    expect(compactRoot(container)?.textContent).toContain("Uses – dashes.");
    expect(compactRoot(container)?.textContent).not.toContain("\\u2013");
  });

  it("supports the full GFM and safety contract", async () => {
    const { container } = render(
      <CollabMarkdownText
        content={[
          "Uses ~~legacy~~ **canonical** rendering.",
          "",
          '<button data-injected onclick="alert(1)">danger</button>',
        ].join("\n")}
      />,
    );

    await waitFor(() => expect(compactRoot(container)).not.toBeNull());

    expect(screen.getByText("legacy").tagName).toBe("DEL");
    expect(screen.getByText("canonical").tagName).toBe("STRONG");
    // Raw HTML is shown as text, never executed.
    expect(container.querySelector("button[data-injected]")).toBeNull();
    expect(compactRoot(container)?.textContent).toContain(
      "<button data-injected",
    );
  });

  it("shows no duplicate loading fallback while the renderer resolves", () => {
    const { container } = render(
      <CollabMarkdownText content="loading behavior" />,
    );

    // The legacy card wrapper mounted its own `.markdown-loading` <pre> on top
    // of the dynamic loader's fallback. The canonical adapter has one.
    expect(container.querySelector(".markdown-loading")).toBeNull();
  });

  it("applies the caller className to an outer wrapper, never to the adapter root", async () => {
    const { container } = render(
      <CollabMarkdownText content="placed" className="host-placement" />,
    );

    const wrapper = container.querySelector(".host-placement");
    expect(wrapper).not.toBeNull();

    await waitFor(() => expect(compactRoot(container)).not.toBeNull());
    // The placement class stays on the host wrapper; it is not forwarded into
    // the canonical adapter's generated root.
    expect(compactRoot(container)?.classList.contains("host-placement")).toBe(
      false,
    );
    // The generated-descendant CSS hook is gone.
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });

  it("keeps long unbroken narrative content inside the overflow-safe compact root", async () => {
    const longToken = "x".repeat(240);
    const { container } = render(
      <CollabMarkdownText content={longToken} className="min-w-0 flex-auto" />,
    );

    await waitFor(() => expect(compactRoot(container)).not.toBeNull());
    const root = compactRoot(container);
    expect(root?.textContent).toContain(longToken);
    // Overflow safety is owned by the canonical module, not the card.
    expect(root?.className).toContain("min-w-0");
    expect(root?.className).toContain("break-words");
  });
});
