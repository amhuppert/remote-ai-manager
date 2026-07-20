import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { segmentTextByRefs } from "@/lib/conversations/ref-segments";
import { REFERENCE_REGISTRY, getReferenceByXmlTag } from "./reference-registry";

/**
 * Tiptap extension that intercepts pasted plain text containing
 * registered reference tags and inserts them as mention chips, keeping the
 * surrounding text. Pastes without a schema-valid ref fall through to default
 * handling.
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
              !REFERENCE_REGISTRY.some((entry) =>
                text.includes(`<${entry.xmlTag}`),
              )
            ) {
              return false;
            }

            const schema = view.state.schema;
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
              if (segment.type !== "text") {
                const reference = getReferenceByXmlTag(segment.type);
                const nodeType = reference
                  ? schema.nodes[reference.nodeName]
                  : undefined;
                pushMention(
                  reference && nodeType
                    ? nodeType.create(reference.parseAttrs(segment.attrs))
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
