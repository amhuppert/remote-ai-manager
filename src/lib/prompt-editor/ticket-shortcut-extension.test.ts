// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { TicketMentionNode } from "./ticket-mention-node";
import { TicketShortcut } from "./ticket-shortcut-extension";

beforeEach(() => {
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
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
});

describe("TicketShortcut extension", () => {
  it("opens on ! and inserts the selected ticket as a ticketMention node", async () => {
    const commandRef: { current: ((item: unknown) => void) | null } = {
      current: null,
    };
    const dom = document.createElement("div");
    document.body.appendChild(dom);
    const editor = new Editor({
      element: dom,
      extensions: [
        StarterKit,
        TicketMentionNode,
        TicketShortcut.configure({
          items: () => [],
          render: () => ({
            onStart: (props) => {
              commandRef.current = props.command as (item: unknown) => void;
            },
          }),
        }),
      ],
      content: "<p></p>",
    });

    editor.chain().insertContent("!").run();
    await Promise.resolve();
    expect(commandRef.current).not.toBeNull();

    commandRef.current?.({
      projectName: "alpha",
      ticketNumber: "12",
      identifier: "alpha#12",
      title: "Harden auth",
      id: "t12",
    });
    const node = editor.state.doc.firstChild?.firstChild;
    expect(node?.type.name).toBe("ticketMention");
    expect(node?.attrs).toMatchObject({
      identifier: "alpha#12",
      title: "Harden auth",
    });
    editor.destroy();
  });
});
