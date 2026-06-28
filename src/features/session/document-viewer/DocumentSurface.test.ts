// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { ResolvedComment } from "./types";
import { jumpToComment } from "./DocumentSurface";
import { CC_LINE_ATTR, CC_SECTION_ATTR } from "./markdown-components";

function resolvedComment(): ResolvedComment {
  const base: DocumentComment = {
    id: "c1",
    projectPath: "/proj",
    sessionName: "sess",
    docPath: "doc.md",
    anchor: {
      sectionId: "title",
      headingLabel: "Title",
      line: 3,
      charStart: 0,
      charEnd: 16,
      quote: "quotable passage",
      prefix: "",
      suffix: "",
      docRevision: "rev-1",
    },
    note: "tighten this passage",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
  };
  return {
    ...base,
    reanchor: { status: "anchored", charStart: 0, charEnd: 16 },
    stale: false,
  };
}

function renderedContent(): HTMLElement {
  const container = document.createElement("div");
  const block = document.createElement("p");
  block.setAttribute(CC_LINE_ATTR, "3");
  block.setAttribute(CC_SECTION_ATTR, "title");
  block.textContent = "quotable passage";
  block.scrollIntoView = vi.fn();
  container.append(block);
  return container;
}

describe("jumpToComment", () => {
  it("activates the document, scrolls the anchored block, and opens the comment card", () => {
    const content = renderedContent();
    const block = content.querySelector("p") as HTMLElement;
    const activateDocument = vi.fn();
    const openComment = vi.fn();

    jumpToComment({
      comments: [resolvedComment()],
      commentId: "c1",
      docPath: "doc.md",
      contentEl: content,
      activateDocument,
      openComment,
    });

    expect(activateDocument).toHaveBeenCalledWith("doc.md");
    // Instant (not smooth) so the passage rect is final before the comment card
    // mounts and positions against it — a smooth animation would leave the card
    // pinned to the pre-scroll location.
    expect(block.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(openComment).toHaveBeenCalledWith("c1");
  });
});
