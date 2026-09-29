import { Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** Preserve each source line; ProseMirror's default parser collapses blank lines. */
export const PlainTextPaste = Extension.create({
  name: "plainTextPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("plainTextPaste"),
        props: {
          clipboardTextParser(text, $context, _plain, view) {
            const { schema } = view.state;
            const marks = $context.marks();
            const lines = text.replace(/\r\n?/g, "\n").split("\n");
            return Slice.maxOpen(
              Fragment.fromArray(
                lines.map((line) =>
                  schema.node(
                    "paragraph",
                    null,
                    line ? schema.text(line, marks) : undefined,
                  ),
                ),
              ),
            );
          },
        },
      }),
    ];
  },
});
