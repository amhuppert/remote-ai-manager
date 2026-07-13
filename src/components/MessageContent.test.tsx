// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MessageContent from "./MessageContent";
import type { ThinkingBlockExpansionCommand } from "./ThinkingBlock";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("MessageContent — image_marker caption", () => {
  it("renders #N caption from an image_marker block", () => {
    const content: MessageContentBlock[] = [
      {
        type: "image_marker",
        index: 3,
        mediaType: "image/png",
        imagePath: "/tmp/3.png",
      },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ];
    render(<MessageContent content={content} />);
    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  it("renders the caption above the image in document order", () => {
    const content: MessageContentBlock[] = [
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/tmp/1.png",
      },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ];
    const { container } = render(<MessageContent content={content} />);
    // The caption should appear before the <img> in the rendered tree.
    const caption = screen.getByText("#1");
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const captionPosition =
      caption.compareDocumentPosition(img!) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(captionPosition).not.toBe(0);
  });

  it("renders multiple captions for interleaved markers", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: "Compare these:" },
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/tmp/1.png",
      },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
      { type: "text", text: " and " },
      {
        type: "image_marker",
        index: 2,
        mediaType: "image/png",
        imagePath: "/tmp/2.png",
      },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ];
    render(<MessageContent content={content} />);
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
  });
});

describe("MessageContent — thinking block", () => {
  it("renders an expanded reasoning aside by default", () => {
    const content: MessageContentBlock[] = [
      {
        type: "thinking",
        text: "Two candidates: a regression or a stale test.",
      },
      { type: "text", text: "The component is correct." },
    ];
    render(<MessageContent content={content} />);

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Two candidates/)).toBeInTheDocument();
    expect(screen.getByText("The component is correct.")).toBeInTheDocument();
  });

  it("combines consecutive thinking blocks into one disclosure", () => {
    const content: MessageContentBlock[] = [
      { type: "thinking", text: "First thought." },
      { type: "thinking", text: "Second thought." },
      { type: "text", text: "Answer." },
      { type: "thinking", text: "Later thought." },
    ];
    render(<MessageContent content={content} />);

    expect(screen.getAllByRole("button", { name: /thinking/i })).toHaveLength(
      2,
    );
    expect(screen.getByText(/First thought/)).toBeInTheDocument();
    expect(screen.getByText(/Second thought/)).toBeInTheDocument();
    expect(screen.getByText("Later thought.")).toBeInTheDocument();
  });

  it("keeps redacted thinking visible when combined with visible thinking", () => {
    const content: MessageContentBlock[] = [
      { type: "thinking", text: "Visible thought." },
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "Answer." },
    ];
    render(<MessageContent content={content} />);

    expect(screen.getAllByRole("button", { name: /thinking/i })).toHaveLength(
      1,
    );
    expect(screen.getByText("Visible thought.")).toBeInTheDocument();
    expect(screen.getByText("Internal reasoning")).toBeInTheDocument();
    expect(screen.getByText("— hidden")).toBeInTheDocument();
  });
  it("collapses and expands thinking blocks from conversation-level commands", () => {
    const content: MessageContentBlock[] = [
      { type: "thinking", text: "Commanded thought." },
    ];

    function Harness(): React.JSX.Element {
      const [command, setCommand] = useState<ThinkingBlockExpansionCommand>({
        expanded: true,
        revision: 0,
      });
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setCommand((prev) => ({
                expanded: false,
                revision: prev.revision + 1,
              }))
            }
          >
            collapse
          </button>
          <button
            type="button"
            onClick={() =>
              setCommand((prev) => ({
                expanded: true,
                revision: prev.revision + 1,
              }))
            }
          >
            expand
          </button>
          <MessageContent
            content={content}
            thinkingExpansionCommand={command}
          />
        </>
      );
    }

    render(<Harness />);

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Commanded thought.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "collapse" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Commanded thought.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "expand" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Commanded thought.")).toBeInTheDocument();
  });

  it("renders the reasoning body as markdown once expanded", async () => {
    const content: MessageContentBlock[] = [
      {
        type: "thinking",
        text: "Check **the selector** and the `cn()` helper.",
      },
    ];
    render(<MessageContent content={content} />);

    // Markdown renders to semantic elements (not literal **/`` text). The
    // markdown renderer is lazy-loaded, so allow for the dynamic import under
    // parallel-suite load (mirrors the canonical Markdown adapter's deferred-render budget).
    const strong = await screen.findByText(
      "the selector",
      {},
      { timeout: 5000 },
    );
    expect(strong.tagName).toBe("STRONG");
    const code = await screen.findByText("cn()", {}, { timeout: 5000 });
    expect(code.tagName).toBe("CODE");
  });

  it("renders a redacted thinking block as a label-only indicator with no toggle or body", () => {
    const content: MessageContentBlock[] = [
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "Answer." },
    ];
    render(<MessageContent content={content} />);

    expect(screen.getByText("Internal reasoning")).toBeInTheDocument();
    expect(screen.getByText("— hidden")).toBeInTheDocument();
    // Redacted reasoning cannot be expanded — there is no disclosure control.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("MessageContent — document_feedback block", () => {
  it("renders the DocumentFeedbackCard for a document_feedback block", () => {
    const content: MessageContentBlock[] = [
      {
        type: "document_feedback",
        items: [
          {
            docPath: "design.md",
            path: "design.md",
            headingLabel: "Intro",
            line: 12,
            quote: "the quoted passage",
            note: "please revise",
          },
        ],
      },
    ];
    render(<MessageContent content={content} />);
    expect(screen.getByTestId("document-feedback-card")).toBeInTheDocument();
    expect(screen.getByText("design.md")).toBeInTheDocument();
    expect(screen.getByText("§ Intro · L12")).toBeInTheDocument();
    expect(screen.getByText(/the quoted passage/)).toBeInTheDocument();
    expect(screen.getByText("please revise")).toBeInTheDocument();
  });
});

describe("MessageContent — tool use disclosures", () => {
  it("collapses a standalone Bash tool use by default", () => {
    const command = [
      "bun test src/components/MessageContent.test.tsx",
      "bun test src/components/conversation/MessageRow.test.tsx",
      "bun run typecheck",
    ].join("\n");
    const content: MessageContentBlock[] = [
      {
        type: "tool_use",
        id: "tool_1",
        name: "Bash",
        input: { command, description: "Run verification" },
      },
      { type: "tool_result", tool_use_id: "tool_1", metrics: { exitCode: 0 } },
    ];
    const commandMatcher = (_text: string, element: Element | null) =>
      element?.tagName === "PRE" && element.textContent === command;

    render(<MessageContent content={content} />);

    const toggle = screen.getByRole("button", { name: /1 tool use/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(commandMatcher)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(commandMatcher)).toBeInTheDocument();
  });
});
