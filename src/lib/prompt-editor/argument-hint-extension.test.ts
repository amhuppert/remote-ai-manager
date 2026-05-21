// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ArgumentHint } from "./argument-hint-extension";
import { SlashCommandMarker } from "./slash-command-marker-node";

beforeEach(() => {
  if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* () {},
        }) as unknown as DOMRectList;
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }
  }
});

function makeEditor() {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  return new Editor({
    element: dom,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        underline: false,
        trailingNode: false,
      }),
      SlashCommandMarker,
      ArgumentHint,
    ],
    content: "<p></p>",
  });
}

function ghostElements(editor: Editor): HTMLElement[] {
  return Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>("[data-arg-hint]"),
  );
}

describe("ArgumentHint extension", () => {
  it("renders a ghost widget after a chip with argumentHint", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/spec-init",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: "<project-description>",
        },
      })
      .run();

    const ghosts = ghostElements(editor);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]?.textContent).toBe("<project-description>");
    editor.destroy();
  });

  it("does not render a ghost when argumentHint is null", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/review",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: null,
        },
      })
      .run();

    expect(ghostElements(editor)).toHaveLength(0);
    editor.destroy();
  });

  it("hides the ghost once non-whitespace text follows the chip", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/spec-init",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: "<arg>",
        },
      })
      .insertContent(" hello")
      .run();

    expect(ghostElements(editor)).toHaveLength(0);
    editor.destroy();
  });

  it("keeps the ghost visible when only whitespace follows the chip", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/spec-init",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: "<arg>",
        },
      })
      .insertContent("   ")
      .run();

    expect(ghostElements(editor)).toHaveLength(1);
    editor.destroy();
  });

  it("renders one ghost per chip when multiple are present in the doc", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/a",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: "<a-arg>",
        },
      })
      .insertContent({ type: "paragraph" })
      .insertContent({
        type: "slashCommandMarker",
        attrs: {
          name: "/b",
          trigger: "/",
          kind: "command",
          source: "user",
          description: null,
          argumentHint: "<b-arg>",
        },
      })
      .run();

    const texts = ghostElements(editor).map((el) => el.textContent);
    expect(texts).toEqual(["<a-arg>", "<b-arg>"]);
    editor.destroy();
  });
});
