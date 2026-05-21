import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const ARGUMENT_HINT_PLUGIN_KEY = new PluginKey<DecorationSet>(
  "argumentHintDecorations",
);

/**
 * Whether the inline content from `from` up to the end of the paragraph
 * containing `from` already has user-typed material (text with non-whitespace,
 * a hard break, or another atomic inline chip). Used to decide if the
 * argument-hint ghost should still be visible.
 */
function paragraphAfterHasContent(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  const parentEnd = $from.end($from.depth);
  if (from >= parentEnd) return false;

  let hasContent = false;
  state.doc.nodesBetween(from, parentEnd, (node) => {
    if (hasContent) return false;
    if (node.isText) {
      const text = node.text ?? "";
      if (text.trim().length > 0) hasContent = true;
      return false;
    }
    if (node.type.name === "hardBreak") {
      hasContent = true;
      return false;
    }
    if (node.isInline && node.isAtom) {
      hasContent = true;
      return false;
    }
    return true;
  });
  return hasContent;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name !== "slashCommandMarker") return undefined;
    const hint = node.attrs["argumentHint"];
    if (typeof hint !== "string" || hint.length === 0) return false;

    const after = pos + node.nodeSize;
    if (paragraphAfterHasContent(state, after)) return false;

    decorations.push(
      Decoration.widget(
        after,
        () => {
          const span = document.createElement("span");
          span.className = "prompt-editor__arg-hint";
          span.setAttribute("contenteditable", "false");
          span.setAttribute("data-arg-hint", "");
          span.textContent = hint;
          return span;
        },
        { side: 1, ignoreSelection: true },
      ),
    );
    return false;
  });

  return DecorationSet.create(state.doc, decorations);
}

/**
 * Renders a ghost-text widget after every `slashCommandMarker` chip whose
 * `argumentHint` attribute is set, until the user types real content after
 * the chip in the same paragraph. The decoration is non-editable and is
 * skipped by selection so cursor movement around the chip is unaffected.
 */
export const ArgumentHint = Extension.create({
  name: "argumentHint",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: ARGUMENT_HINT_PLUGIN_KEY,
        state: {
          init: (_, state) => buildDecorations(state),
          apply: (tr, prev, _oldState, newState) => {
            if (!tr.docChanged) return prev.map(tr.mapping, tr.doc);
            return buildDecorations(newState);
          },
        },
        props: {
          decorations(state) {
            return ARGUMENT_HINT_PLUGIN_KEY.getState(state);
          },
        },
      }),
    ];
  },
});
