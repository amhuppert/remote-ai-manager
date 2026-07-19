// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Slice } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeFormatting } from "./code-formatting-extension";

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEditor(content = ""): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ trailingNode: false }), CodeFormatting],
    content,
  });
}

function dispatchKey(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, key });
  return (
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, event),
    ) === true
  );
}

function pastePlainText(editor: Editor, text: string): boolean {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return (
    editor.view.someProp("handlePaste", (handler) =>
      handler(editor.view, event as ClipboardEvent, Slice.empty),
    ) === true
  );
}

describe("CodeFormatting fenced code", () => {
  it("pastes an exact complete fence as a code block with a trailing paragraph", () => {
    const editor = makeEditor();

    expect(
      pastePlainText(
        editor,
        "```c++\r\nint main() {\r\n  return 0;\r\n}\r\n```\r\n",
      ),
    ).toBe(true);

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "c++" },
          content: [{ type: "text", text: "int main() {\n  return 0;\n}" }],
        },
        { type: "paragraph" },
      ],
    });
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    editor.destroy();
  });

  it("leaves surrounding or unmatched fence text to the normal paste handler", () => {
    const editor = makeEditor();

    expect(pastePlainText(editor, "before\n```ts\ncode\n```\nafter")).toBe(
      false,
    );
    expect(pastePlainText(editor, "```ts\ncode")).toBe(false);
    expect(editor.getText()).toBe("");
    editor.destroy();
  });

  it("uses existing text after the selection as the trailing paragraph", () => {
    const editor = makeEditor("<p>beforeafter</p>");
    editor.commands.setTextSelection(7);

    expect(pastePlainText(editor, "```ts\nconst value = 1;\n```")).toBe(true);

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const value = 1;" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    expect(editor.state.selection.$from.parent.textContent).toBe("after");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    editor.destroy();
  });

  it("uses an existing following block instead of inserting a blank paragraph", () => {
    const editor = makeEditor("<p>before</p><p>after</p>");
    editor.commands.setTextSelection(7);

    expect(pastePlainText(editor, "```ts\nconst value = 1;\n```")).toBe(true);

    expect(editor.getJSON().content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "before" }],
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const value = 1;" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "after" }],
      },
    ]);
    expect(editor.state.selection.$from.parent.textContent).toBe("after");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    editor.destroy();
  });

  it.each(["```", "~~~"])(
    "removes a %s closing line and exits the code block on Enter",
    (fence) => {
      const editor = makeEditor();
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "codeBlock",
            content: [{ type: "text", text: `const n = 1;\n${fence}` }],
          },
        ],
      });
      editor.commands.focus("end");

      expect(dispatchKey(editor, "Enter")).toBe(true);
      expect(editor.getJSON()).toMatchObject({
        content: [
          {
            type: "codeBlock",
            content: [{ type: "text", text: "const n = 1;" }],
          },
          { type: "paragraph" },
        ],
      });
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      editor.destroy();
    },
  );
});

describe("CodeFormatting inline code boundaries", () => {
  it.each([
    { key: "Backspace", selection: 4 },
    { key: "Delete", selection: 1 },
  ])(
    "unwraps inline code on $key without deleting text",
    ({ key, selection }) => {
      const editor = makeEditor("<p><code>foo</code></p>");
      editor.commands.setTextSelection(selection);

      expect(dispatchKey(editor, key)).toBe(true);
      expect(editor.getJSON()).toEqual({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "foo" }] },
        ],
      });
      editor.destroy();
    },
  );
});

describe("CodeFormatting code block boundaries", () => {
  it("unwraps the current code block on Backspace at its start", () => {
    const editor = makeEditor("<p>before</p><pre><code>foo</code></pre>");
    editor.commands.setTextSelection(9);

    expect(dispatchKey(editor, "Backspace")).toBe(true);
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "foo" }],
    });
    editor.destroy();
  });

  it("unwraps the preceding code block on Backspace from the next block", () => {
    const editor = makeEditor("<pre><code>foo</code></pre><p>after</p>");
    editor.commands.setTextSelection(6);

    expect(dispatchKey(editor, "Backspace")).toBe(true);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "foo" }],
    });
    editor.destroy();
  });

  it("unwraps the current code block on Delete at its end", () => {
    const editor = makeEditor("<pre><code>foo</code></pre><p>after</p>");
    editor.commands.setTextSelection(4);

    expect(dispatchKey(editor, "Delete")).toBe(true);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "foo" }],
    });
    editor.destroy();
  });

  it("unwraps the following code block on Delete from the previous block", () => {
    const editor = makeEditor("<p>before</p><pre><code>foo</code></pre>");
    editor.commands.setTextSelection(7);

    expect(dispatchKey(editor, "Delete")).toBe(true);
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "foo" }],
    });
    editor.destroy();
  });
});
