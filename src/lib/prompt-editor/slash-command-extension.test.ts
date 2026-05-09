// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SlashCommand } from "./slash-command-extension";

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

function makeEditorWithTriggers(triggerChars: readonly string[]) {
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  const onStart = vi.fn<(triggerChar: string, query: string) => void>();
  const onUpdate = vi.fn<(triggerChar: string, query: string) => void>();

  const triggers = triggerChars.map((char) => ({
    char,
    items: () => [],
    render: () => ({
      onStart: (props: { query: string }) => onStart(char, props.query),
      onUpdate: (props: { query: string }) => onUpdate(char, props.query),
      onExit: () => {},
      onKeyDown: () => false,
    }),
  }));

  const editor = new Editor({
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
      SlashCommand.configure({ triggers }),
    ],
    content: "<p></p>",
  });

  return { editor, onStart, onUpdate };
}

describe("SlashCommand extension — multiple triggers", () => {
  it("fires onStart for the / trigger when typing / at start of line", async () => {
    const { editor, onStart } = makeEditorWithTriggers(["/", "$"]);
    editor.chain().insertContent("/").run();
    await Promise.resolve();

    expect(onStart).toHaveBeenCalled();
    expect(onStart.mock.calls.some(([trig]) => trig === "/")).toBe(true);
    editor.destroy();
  });

  it("fires onStart for the $ trigger when typing $ at start of line", async () => {
    const { editor, onStart } = makeEditorWithTriggers(["/", "$"]);
    editor.chain().insertContent("$").run();
    await Promise.resolve();

    expect(onStart).toHaveBeenCalled();
    expect(onStart.mock.calls.some(([trig]) => trig === "$")).toBe(true);
    editor.destroy();
  });

  it("supports a single $ trigger without /", async () => {
    const { editor, onStart } = makeEditorWithTriggers(["$"]);
    editor.chain().insertContent("$").run();
    await Promise.resolve();

    expect(onStart.mock.calls.some(([trig]) => trig === "$")).toBe(true);
    editor.destroy();
  });

  it("does not fire $ trigger when only / is configured", async () => {
    const { editor, onStart } = makeEditorWithTriggers(["/"]);
    editor.chain().insertContent("$").run();
    await Promise.resolve();

    expect(onStart.mock.calls.some(([trig]) => trig === "$")).toBe(false);
    editor.destroy();
  });

  it("propagates the typed query to the suggestion handlers", async () => {
    const { editor, onStart, onUpdate } = makeEditorWithTriggers(["$"]);
    editor.chain().insertContent("$skill").run();
    await Promise.resolve();

    const allCalls = [...onStart.mock.calls, ...onUpdate.mock.calls];
    expect(allCalls.some(([trig, q]) => trig === "$" && q === "skill")).toBe(
      true,
    );
    editor.destroy();
  });
});
