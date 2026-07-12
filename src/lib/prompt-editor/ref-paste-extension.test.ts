// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { RefPasteHandler } from "./ref-paste-extension";
import { TicketMentionNode } from "./ticket-mention-node";
import { serializePromptDoc } from "./serializer";
import { buildTicketRefXml } from "@/lib/tickets/references";

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
      TicketMentionNode,
      RefPasteHandler,
    ],
    content: "<p></p>",
  });
}

/**
 * jsdom has no constructible ClipboardEvent carrying data, so a plain Event
 * gets the minimal clipboardData surface the paste handler reads.
 */
function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
}

function paste(editor: Editor, text: string): void {
  editor.commands.focus("end");
  editor.view.pasteText(text, pasteEvent(text));
}

function findTicketMentions(
  editor: Editor,
): Array<{ node: ProseMirrorNode; pos: number }> {
  const found: Array<{ node: ProseMirrorNode; pos: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "ticketMention") found.push({ node, pos });
  });
  return found;
}

const TICKET_XML = buildTicketRefXml({
  projectName: "command-center",
  ticketNumber: 12,
  title: "Add durable ticket context",
});

describe("RefPasteHandler ticket refs", () => {
  it("renders a pasted ticket ref among text as a ticketMention atom", () => {
    const editor = makeEditor();
    paste(editor, `before ${TICKET_XML} after`);

    const mentions = findTicketMentions(editor);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.node.attrs).toMatchObject({
      projectName: "command-center",
      ticketNumber: "12",
      identifier: "command-center#12",
      title: "Add durable ticket context",
    });
    expect(editor.state.doc.textContent).toContain("before");
    expect(editor.state.doc.textContent).toContain("after");
  });

  it("serializes the pasted chip back to canonical ticket-ref XML in place", () => {
    const editor = makeEditor();
    paste(editor, `before ${TICKET_XML} after`);

    const { prompt } = serializePromptDoc({
      doc: editor.state.doc,
      attachments: [],
    });
    expect(prompt).toBe(`before ${TICKET_XML} after`);
  });

  it("excludes the reference from the serialized prompt once the chip is removed", () => {
    const editor = makeEditor();
    paste(editor, `before ${TICKET_XML} after`);

    const mentions = findTicketMentions(editor);
    expect(mentions).toHaveLength(1);
    const { pos } = mentions[0]!;
    editor.commands.deleteRange({ from: pos, to: pos + 1 });

    expect(findTicketMentions(editor)).toHaveLength(0);
    const { prompt } = serializePromptDoc({
      doc: editor.state.doc,
      attachments: [],
    });
    expect(prompt).not.toContain("<ticket-ref");
    expect(prompt).toContain("before");
    expect(prompt).toContain("after");
  });

  it("leaves a malformed ticket ref as plain text without creating a chip", () => {
    const editor = makeEditor();
    const malformed = '<ticket-ref project-name="command-center" />';
    paste(editor, `see ${malformed} here`);

    expect(findTicketMentions(editor)).toHaveLength(0);
    expect(editor.state.doc.textContent).toContain(malformed);
  });
});
