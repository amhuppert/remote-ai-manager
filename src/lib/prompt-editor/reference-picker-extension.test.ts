// @vitest-environment jsdom
import { Editor, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationMentionNode } from "./conversation-mention-node";
import { FileMentionNode } from "./file-mention-node";
import { TerminalHotkeys } from "./terminal-hotkeys-extension";
import type { PickerTrigger } from "./reference-picker";
import {
  ReferencePicker,
  type ReferencePickerSuggestion,
} from "./reference-picker-extension";
import { TicketMentionNode } from "./ticket-mention-node";

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

interface Harness {
  editor: Editor;
  /** The most recent suggestion for each trigger, or null once it exited. */
  open(trigger: PickerTrigger): ReferencePickerSuggestion | null;
  queries: string[];
  /** Keys the popup claimed, in order. */
  claimed: string[];
}

function harness(options?: {
  hasAnyMatch?: (query: string) => boolean;
  /** Keys the popup consumes, mirroring what the real popup binds. */
  claims?: (event: KeyboardEvent) => boolean;
  extraExtensions?: readonly Extensions[number][];
}) {
  const suggestions: Partial<Record<PickerTrigger, ReferencePickerSuggestion>> =
    {};
  const closed = new Set<PickerTrigger>();
  const queries: string[] = [];
  const claimed: string[] = [];
  const dom = document.createElement("div");
  document.body.appendChild(dom);

  const editor = new Editor({
    element: dom,
    extensions: [
      StarterKit,
      FileMentionNode,
      ConversationMentionNode,
      TicketMentionNode,
      ReferencePicker.configure({
        hasAnyMatch: options?.hasAnyMatch ?? (() => true),
        render: (trigger) => ({
          onStart: (suggestion) => {
            closed.delete(trigger);
            suggestions[trigger] = suggestion;
            queries.push(suggestion.query);
          },
          onUpdate: (suggestion) => {
            suggestions[trigger] = suggestion;
            queries.push(suggestion.query);
          },
          onExit: () => {
            closed.add(trigger);
          },
          onKeyDown: ({ event }) => {
            if (!(options?.claims?.(event) ?? false)) return false;
            claimed.push(event.code || event.key);
            event.preventDefault();
            return true;
          },
        }),
      }),
      ...(options?.extraExtensions ?? []),
    ],
    content: "<p></p>",
  });

  const result: Harness = {
    editor,
    queries,
    claimed,
    open: (trigger) =>
      closed.has(trigger) ? null : (suggestions[trigger] ?? null),
  };
  return result;
}

async function type(editor: Editor, text: string): Promise<void> {
  for (const character of text) {
    editor.chain().insertContent(character).run();
    await Promise.resolve();
  }
}

describe("ReferencePicker extension", () => {
  it("opens on each of the three trigger characters", async () => {
    for (const trigger of ["@", "#", "!"] as const) {
      const app = harness();
      await type(app.editor, trigger);
      expect(app.open(trigger)?.trigger).toBe(trigger);
    }
  });

  it("keeps the query growing across spaces", async () => {
    const app = harness();

    await type(app.editor, "#auth token refresh");

    expect(app.open("#")?.query).toBe("auth token refresh");
  });

  it("closes once a spaced query stops matching anything", async () => {
    // Stands in for the real model: only a prefix of a known name matches.
    const app = harness({
      hasAnyMatch: (query) => "auth token refresh".startsWith(query),
    });

    await type(app.editor, "#auth token");
    expect(app.open("#")?.query).toBe("auth token");

    await type(app.editor, " and unrelated prose");
    expect(app.open("#")).toBeNull();
  });

  it("keeps an explicit execution search open while remote results have not arrived", async () => {
    const app = harness({ hasAnyMatch: () => false });
    await type(app.editor, "#exec: Capture delivery");
    expect(app.open("#")?.query).toBe("exec: Capture delivery");
    app.editor.destroy();
  });

  it("keeps a spaceless query open even when nothing matches", async () => {
    const app = harness({ hasAnyMatch: () => false });

    await type(app.editor, "#zzz");

    expect(app.open("#")?.query).toBe("zzz");
  });

  it("hands the caret to a later trigger instead of opening two pickers", async () => {
    const app = harness();

    await type(app.editor, "#notes @src");

    expect(app.open("#")).toBeNull();
    expect(app.open("@")?.query).toBe("src");
  });

  it("reports whether the caret sits at the end of the query", async () => {
    const app = harness();
    await type(app.editor, "#sess");
    expect(app.open("#")?.isCaretAtQueryEnd()).toBe(true);

    app.editor.commands.setTextSelection(3);
    expect(app.open("#")?.isCaretAtQueryEnd()).toBe(false);
  });

  it("inserts a file mention when a file row is selected from any trigger", async () => {
    const app = harness();
    await type(app.editor, "#prompt");

    app.open("#")?.select({
      kind: "file",
      path: "src/lib/prompt.ts",
      basename: "prompt.ts",
      ext: "ts",
    });

    const node = firstNode(app.editor);
    expect(node?.type.name).toBe("fileMention");
    expect(node?.attrs).toMatchObject({
      path: "src/lib/prompt.ts",
      basename: "prompt.ts",
      ext: "ts",
    });
  });

  it("inserts the registry node for a reference row from any trigger", async () => {
    const app = harness();
    await type(app.editor, "@142");

    app.open("@")?.select({
      kind: "reference",
      type: "ticket",
      attrs: {
        projectName: "alpha",
        ticketNumber: "142",
        identifier: "alpha#142",
        title: "Redesign prompt autocomplete",
      },
    });

    const node = firstNode(app.editor);
    expect(node?.type.name).toBe("ticketMention");
    expect(node?.attrs).toMatchObject({ identifier: "alpha#142" });
  });

  it("wins Alt+D from the terminal delete-word hotkey while open", async () => {
    const app = harness({
      claims: (event) => event.altKey && event.code === "KeyD",
      extraExtensions: [TerminalHotkeys.configure({ onSubmit: () => {} })],
    });
    await type(app.editor, "#auth token");
    const before = app.editor.getText();

    app.editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(app.claimed).toEqual(["KeyD"]);
    expect(app.editor.getText()).toBe(before);
  });

  it("leaves Alt+D to the terminal hotkey once the picker has closed", async () => {
    const app = harness({
      claims: (event) => event.altKey && event.code === "KeyD",
      extraExtensions: [TerminalHotkeys.configure({ onSubmit: () => {} })],
    });
    await type(app.editor, "auth token");
    app.editor.commands.setTextSelection(1);

    app.editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(app.claimed).toEqual([]);
    expect(app.editor.getText()).not.toBe("auth token");
  });

  it("completes the query in place without closing the picker", async () => {
    const app = harness();
    await type(app.editor, "#sess");

    app.open("#")?.complete("session-workflows");
    await Promise.resolve();

    expect(app.editor.getText()).toBe("#session-workflows");
    expect(app.open("#")?.query).toBe("session-workflows");
  });

  it("completes a title containing markup as literal text", async () => {
    const app = harness();
    await type(app.editor, "#a");

    app.open("#")?.complete("<b>not markup</b>");
    await Promise.resolve();

    expect(app.editor.getText()).toBe("#<b>not markup</b>");
  });
});

function firstNode(editor: Editor) {
  return editor.state.doc.firstChild?.firstChild ?? null;
}
