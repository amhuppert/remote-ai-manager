import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { segmentTextByRefs } from "@/lib/conversations/ref-segments";
import { conversationRefAttrsToMentionAttrs } from "./conversation-mention-node";
import { messageRefAttrsToMentionAttrs } from "./message-mention-node";

/**
 * Tiptap extension that intercepts pasted plain text containing
 * `<conversation-ref ... />` or `<message-ref ... />` tags (copied from a
 * conversation reference or a message's Copy-reference action) and inserts
 * them as mention chips, keeping the surrounding text. Pastes without a
 * schema-valid ref fall through to default handling.
 */
export const RefPasteHandler = Extension.create({
  name: "refPasteHandler",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("refPasteHandler"),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain");
            if (
              !text ||
              (!text.includes("<conversation-ref") &&
                !text.includes("<message-ref"))
            ) {
              return false;
            }

            const schema = view.state.schema;
            const conversationType = schema.nodes["conversationMention"];
            const messageType = schema.nodes["messageMention"];
            const hardBreakType = schema.nodes["hardBreak"];

            const nodes: ProseMirrorNode[] = [];
            let insertedChip = false;

            const pushText = (value: string) => {
              value.split("\n").forEach((line, lineIndex) => {
                if (lineIndex > 0 && hardBreakType) {
                  nodes.push(hardBreakType.create());
                }
                if (line.length > 0) nodes.push(schema.text(line));
              });
            };

            const pushMention = (node: ProseMirrorNode | null, raw: string) => {
              if (!node) {
                pushText(raw);
                return;
              }
              nodes.push(node);
              insertedChip = true;
            };

            for (const segment of segmentTextByRefs(text)) {
              if (segment.type === "conversation-ref") {
                pushMention(
                  conversationType
                    ? conversationType.create(
                        conversationRefAttrsToMentionAttrs(segment.attrs),
                      )
                    : null,
                  segment.raw,
                );
                continue;
              }
              if (segment.type === "message-ref") {
                pushMention(
                  messageType
                    ? messageType.create(
                        messageRefAttrsToMentionAttrs(segment.attrs),
                      )
                    : null,
                  segment.raw,
                );
                continue;
              }
              pushText(segment.text);
            }

            // Nothing became a chip (e.g. only malformed tags) → let the
            // default paste run so the text lands unchanged.
            if (!insertedChip) return false;

            const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
            view.dispatch(
              view.state.tr.replaceSelection(slice).scrollIntoView(),
            );
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
