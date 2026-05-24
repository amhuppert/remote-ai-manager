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
    const { container } = render(<MessageContent content={content} />);
    const caption = container.querySelector(".message-image-caption");
    expect(caption).not.toBeNull();
    expect(caption!.textContent).toBe("#3");
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
    const children = container.firstChild?.childNodes ?? container.childNodes;
    // The caption should appear before the <img> in the rendered tree.
    const caption = container.querySelector(".message-image-caption");
    const img = container.querySelector("img.message-inline-image");
    expect(caption).not.toBeNull();
    expect(img).not.toBeNull();
    const captionPosition =
      caption!.compareDocumentPosition(img!) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(captionPosition).not.toBe(0);
    void children;
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
