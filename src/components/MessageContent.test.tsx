// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
