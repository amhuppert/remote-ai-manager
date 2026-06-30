// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MessageContent from "./MessageContent";
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
  it("renders a collapsed reasoning aside whose body is hidden until expanded", () => {
    const content: MessageContentBlock[] = [
      {
        type: "thinking",
        text: "Two candidates: a regression or a stale test.",
      },
      { type: "text", text: "The component is correct." },
    ];
    render(<MessageContent content={content} />);

    const toggle = screen.getByRole("button", { name: /thinking/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The reasoning text is not shown while collapsed; the answer always is.
    expect(screen.queryByText(/Two candidates/)).not.toBeInTheDocument();
    expect(screen.getByText("The component is correct.")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Two candidates/)).toBeInTheDocument();
  });

  it("renders the reasoning body as markdown once expanded", async () => {
    const content: MessageContentBlock[] = [
      {
        type: "thinking",
        text: "Check **the selector** and the `cn()` helper.",
      },
    ];
    render(<MessageContent content={content} />);
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    // Markdown renders to semantic elements (not literal **/`` text). The
    // markdown renderer is lazy-loaded, so allow for the dynamic import under
    // parallel-suite load (mirrors MarkdownContent.test.tsx's 5s budget).
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
