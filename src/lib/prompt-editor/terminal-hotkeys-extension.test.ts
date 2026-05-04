// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  TerminalHotkeys,
  findPrevWordStart,
  findNextWordEnd,
} from "./terminal-hotkeys-extension";

// jsdom doesn't implement getClientRects/getBoundingClientRect on
// contenteditable nodes; Tiptap occasionally calls them. Stub for tests.
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

describe("findPrevWordStart (whitespace boundaries)", () => {
  it("returns 0 when offset is 0", () => {
    expect(findPrevWordStart("hello world", 0)).toBe(0);
  });

  it("jumps past trailing whitespace and word characters", () => {
    // "hello world|" — cursor at end of "world" should land at start of "world"
    expect(findPrevWordStart("hello world", 11)).toBe(6);
  });

  it("when cursor is right after a space, jumps to start of preceding word", () => {
    // "hello |world" — cursor at offset 6 (right after space) → start of "hello"
    expect(findPrevWordStart("hello world", 6)).toBe(0);
  });

  it("treats only whitespace as boundary (punctuation stays in word)", () => {
    // "foo.bar baz|" — cursor at end → "baz" → 8; "foo.bar" treated as one word
    expect(findPrevWordStart("foo.bar baz", 11)).toBe(8);
    expect(findPrevWordStart("foo.bar baz", 8)).toBe(0);
  });

  it("when at start of word, jumps to start of previous word", () => {
    expect(findPrevWordStart("alpha beta gamma", 11)).toBe(6);
  });

  it("handles multiple whitespace characters", () => {
    expect(findPrevWordStart("alpha   beta", 12)).toBe(8);
    expect(findPrevWordStart("alpha   beta", 8)).toBe(0);
  });
});

describe("findNextWordEnd (whitespace boundaries)", () => {
  it("returns text length when at end", () => {
    expect(findNextWordEnd("hello world", 11)).toBe(11);
  });

  it("from start, jumps to end of first word", () => {
    expect(findNextWordEnd("hello world", 0)).toBe(5);
  });

  it("from end of word, jumps to end of next word", () => {
    expect(findNextWordEnd("hello world", 5)).toBe(11);
  });

  it("treats only whitespace as boundary", () => {
    expect(findNextWordEnd("foo.bar baz", 0)).toBe(7);
    expect(findNextWordEnd("foo.bar baz", 7)).toBe(11);
  });

  it("handles multiple whitespace characters", () => {
    expect(findNextWordEnd("alpha   beta", 5)).toBe(12);
  });
});

function makeEditor(opts?: { onSubmit?: () => void; doc?: string }): Editor {
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
      TerminalHotkeys.configure({ onSubmit: opts?.onSubmit ?? (() => {}) }),
    ],
    content: opts?.doc ?? "",
  });
}

function dispatchKey(
  editor: Editor,
  init: KeyboardEventInit & { key: string },
): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  return (
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) === true
  );
}

describe("TerminalHotkeys — line navigation", () => {
  it("Ctrl+A moves selection to start of current paragraph", () => {
    const editor = makeEditor({ doc: "<p>hello world</p>" });
    editor.commands.setTextSelection(7); // mid-paragraph
    dispatchKey(editor, { key: "a", ctrlKey: true });
    expect(editor.state.selection.from).toBe(1); // paragraph start
    expect(editor.state.selection.to).toBe(1);
    editor.destroy();
  });

  it("Ctrl+A on multiple paragraphs moves to start of head's paragraph", () => {
    const editor = makeEditor({
      doc: "<p>first line</p><p>second line</p>",
    });
    // Select inside second paragraph: positions 12..23 are inside it (start=13)
    editor.commands.setTextSelection(18);
    dispatchKey(editor, { key: "a", ctrlKey: true });
    expect(editor.state.selection.from).toBe(13);
    editor.destroy();
  });

  it("Ctrl+E moves selection to end of current paragraph", () => {
    const editor = makeEditor({ doc: "<p>hello world</p>" });
    editor.commands.setTextSelection(2);
    dispatchKey(editor, { key: "e", ctrlKey: true });
    expect(editor.state.selection.from).toBe(12); // end of "hello world"
    editor.destroy();
  });
});

describe("TerminalHotkeys — kill line", () => {
  it("Ctrl+U deletes from cursor to start of current paragraph", () => {
    const editor = makeEditor({ doc: "<p>hello world</p>" });
    editor.commands.setTextSelection(7); // between "hello " and "world"
    dispatchKey(editor, { key: "u", ctrlKey: true });
    expect(editor.getText()).toBe("world");
    editor.destroy();
  });

  it("Ctrl+U at start of paragraph is a no-op", () => {
    const editor = makeEditor({ doc: "<p>hello</p>" });
    editor.commands.setTextSelection(1);
    dispatchKey(editor, { key: "u", ctrlKey: true });
    expect(editor.getText()).toBe("hello");
    editor.destroy();
  });

  it("Ctrl+K deletes from cursor to end of current paragraph", () => {
    const editor = makeEditor({ doc: "<p>hello world</p>" });
    editor.commands.setTextSelection(7); // between "hello " and "world"
    dispatchKey(editor, { key: "k", ctrlKey: true });
    expect(editor.getText()).toBe("hello ");
    editor.destroy();
  });

  it("Ctrl+K does not merge across paragraphs", () => {
    const editor = makeEditor({
      doc: "<p>first</p><p>second</p>",
    });
    editor.commands.setTextSelection(3); // mid-first
    dispatchKey(editor, { key: "k", ctrlKey: true });
    // first becomes "fi", second untouched
    expect(editor.getText()).toContain("fi");
    expect(editor.getText()).toContain("second");
    editor.destroy();
  });
});

describe("TerminalHotkeys — word ops", () => {
  it("Alt+B moves cursor back one word", () => {
    const editor = makeEditor({ doc: "<p>alpha beta gamma</p>" });
    editor.commands.setTextSelection(17); // end of "gamma"
    dispatchKey(editor, { key: "b", altKey: true });
    expect(editor.state.selection.from).toBe(12); // start of "gamma"
    editor.destroy();
  });

  it("Alt+F moves cursor forward one word", () => {
    const editor = makeEditor({ doc: "<p>alpha beta gamma</p>" });
    editor.commands.setTextSelection(1); // start
    dispatchKey(editor, { key: "f", altKey: true });
    expect(editor.state.selection.from).toBe(6); // end of "alpha"
    editor.destroy();
  });

  it("Ctrl+W deletes the word before the cursor", () => {
    const editor = makeEditor({ doc: "<p>alpha beta gamma</p>" });
    editor.commands.setTextSelection(11); // end of "beta"
    dispatchKey(editor, { key: "w", ctrlKey: true });
    expect(editor.getText()).toBe("alpha  gamma");
    editor.destroy();
  });

  it("Ctrl+W treats only whitespace as boundary", () => {
    const editor = makeEditor({ doc: "<p>foo.bar baz</p>" });
    editor.commands.setTextSelection(8); // end of "foo.bar"
    dispatchKey(editor, { key: "w", ctrlKey: true });
    expect(editor.getText()).toBe(" baz");
    editor.destroy();
  });

  it("Alt+D deletes the word after the cursor", () => {
    const editor = makeEditor({ doc: "<p>alpha beta gamma</p>" });
    editor.commands.setTextSelection(1); // start
    dispatchKey(editor, { key: "d", altKey: true });
    expect(editor.getText()).toBe(" beta gamma");
    editor.destroy();
  });
});

describe("TerminalHotkeys — submit binding", () => {
  it("Mod+Enter (Ctrl+Enter on non-mac) calls onSubmit", () => {
    const onSubmit = vi.fn();
    const editor = makeEditor({ doc: "<p>hi</p>", onSubmit });
    editor.commands.setTextSelection(2);
    dispatchKey(editor, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("plain Enter does NOT call onSubmit (it splits the paragraph)", () => {
    const onSubmit = vi.fn();
    const editor = makeEditor({ doc: "<p>hello</p>", onSubmit });
    editor.commands.setTextSelection(3); // mid
    dispatchKey(editor, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    // Paragraph should have been split: now two paragraphs joined by \n
    expect(editor.getText()).toBe("he\n\nllo");
    editor.destroy();
  });

  it("Mod+Enter overrides hardBreak's default Mod+Enter binding", () => {
    const onSubmit = vi.fn();
    const editor = makeEditor({ doc: "<p>hi</p>", onSubmit });
    editor.commands.setTextSelection(2);
    const beforeText = editor.getText();
    dispatchKey(editor, { key: "Enter", ctrlKey: true });
    // hardBreak should NOT have been inserted; doc unchanged
    expect(editor.getText()).toBe(beforeText);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    editor.destroy();
  });
});
