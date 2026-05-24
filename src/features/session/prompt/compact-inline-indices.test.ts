// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ImageMarker, type ImageMarkerAttrs } from "@/lib/prompt-editor";
import { compactInlineIndices } from "@/features/session/prompt/PromptEditor";

function buildEditor(markers: ImageMarkerAttrs[]): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ImageMarker],
    content: "",
  });
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: markers.map((attrs) => ({
          type: "imageMarker",
          attrs,
        })),
      },
    ],
  });
  return editor;
}

function getMarkerIndices(editor: Editor): number[] {
  const out: number[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "imageMarker") {
      out.push(node.attrs["index"] as number);
    }
    return undefined;
  });
  return out;
}

describe("compactInlineIndices", () => {
  it("assigns sequential indices starting at cumulativeCount + 1", () => {
    const editor = buildEditor([
      {
        index: 0,
        attachmentId: "a",
        mediaType: "image/png",
        thumbnailUrl: "u-a",
        fileName: null,
      },
      {
        index: 0,
        attachmentId: "b",
        mediaType: "image/png",
        thumbnailUrl: "u-b",
        fileName: null,
      },
      {
        index: 0,
        attachmentId: "c",
        mediaType: "image/png",
        thumbnailUrl: "u-c",
        fileName: null,
      },
    ]);
    compactInlineIndices(editor, 5);
    expect(getMarkerIndices(editor)).toEqual([6, 7, 8]);
    editor.destroy();
  });

  it("starts at 1 when cumulativeCount is 0", () => {
    const editor = buildEditor([
      {
        index: 0,
        attachmentId: "a",
        mediaType: "image/png",
        thumbnailUrl: "u-a",
        fileName: null,
      },
      {
        index: 0,
        attachmentId: "b",
        mediaType: "image/png",
        thumbnailUrl: "u-b",
        fileName: null,
      },
    ]);
    compactInlineIndices(editor, 0);
    expect(getMarkerIndices(editor)).toEqual([1, 2]);
    editor.destroy();
  });

  it("returns false and does not dispatch when indices are already correct", () => {
    const editor = buildEditor([
      {
        index: 1,
        attachmentId: "a",
        mediaType: "image/png",
        thumbnailUrl: "u-a",
        fileName: null,
      },
      {
        index: 2,
        attachmentId: "b",
        mediaType: "image/png",
        thumbnailUrl: "u-b",
        fileName: null,
      },
    ]);
    const result = compactInlineIndices(editor, 0);
    expect(result).toBe(false);
    expect(getMarkerIndices(editor)).toEqual([1, 2]);
    editor.destroy();
  });

  it("returns true when at least one chip needed renumbering", () => {
    const editor = buildEditor([
      {
        index: 1,
        attachmentId: "a",
        mediaType: "image/png",
        thumbnailUrl: "u-a",
        fileName: null,
      },
      {
        index: 99,
        attachmentId: "b",
        mediaType: "image/png",
        thumbnailUrl: "u-b",
        fileName: null,
      },
    ]);
    const result = compactInlineIndices(editor, 0);
    expect(result).toBe(true);
    expect(getMarkerIndices(editor)).toEqual([1, 2]);
    editor.destroy();
  });

  it("preserves non-index attrs when renumbering", () => {
    const editor = buildEditor([
      {
        index: 0,
        attachmentId: "att-x",
        mediaType: "image/jpeg",
        thumbnailUrl: "thumb-x",
        fileName: "x.jpg",
      },
    ]);
    compactInlineIndices(editor, 3);
    let attrs: Record<string, unknown> | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "imageMarker") {
        attrs = node.attrs;
      }
      return undefined;
    });
    expect(attrs).toMatchObject({
      index: 4,
      attachmentId: "att-x",
      mediaType: "image/jpeg",
      thumbnailUrl: "thumb-x",
      fileName: "x.jpg",
    });
    editor.destroy();
  });
});
