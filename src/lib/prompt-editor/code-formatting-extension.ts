import { Extension, getMarkRange } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type {
  MarkType,
  Node as ProseMirrorNode,
  NodeType,
  ResolvedPos,
} from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { createClientLogger } from "@/lib/logging/client-logger";

interface CompleteFence {
  code: string;
  hasLanguage: boolean;
  language: string | null;
}

type BoundaryKey = "Backspace" | "Delete";

const COMPLETE_FENCE_PLUGIN_KEY = new PluginKey("codeFormattingPaste");
const logger = createClientLogger("prompt-editor");

/**
 * Restores conventional code-formatting boundaries that StarterKit's generic
 * join keymaps cannot infer, and recognizes a clipboard payload consisting of
 * exactly one complete Markdown code fence.
 */
export const CodeFormatting = Extension.create({
  name: "codeFormatting",

  priority: 2000,

  addKeyboardShortcuts() {
    return {
      Enter: () => exitOnClosingFence(this.editor),
      Backspace: () =>
        unwrapInlineCode(this.editor, "Backspace") ||
        unwrapCodeBlock(this.editor, "Backspace"),
      Delete: () =>
        unwrapInlineCode(this.editor, "Delete") ||
        unwrapCodeBlock(this.editor, "Delete"),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: COMPLETE_FENCE_PLUGIN_KEY,
        props: {
          handlePaste: (view, event) => {
            const clipboard = event.clipboardData;
            if (!clipboard) return false;
            if (view.state.selection.$from.parent.type.spec.code) return false;

            const parsed = parseCompleteFence(clipboard.getData("text/plain"));
            if (!parsed) return false;

            const codeBlock = view.state.schema.nodes["codeBlock"];
            const paragraph = view.state.schema.nodes["paragraph"];
            if (!codeBlock || !paragraph) return false;

            const codeContent = parsed.code
              ? view.state.schema.text(parsed.code)
              : undefined;
            const { $to } = view.state.selection;
            const hasTrailingText =
              $to.parent.inlineContent &&
              $to.parentOffset < $to.parent.content.size;
            const nextTopLevelIndex =
              $to.depth === 0 ? $to.index(0) : $to.index(0) + 1;
            const hasFollowingBlock =
              nextTopLevelIndex < view.state.doc.childCount;
            const insertedNodes = [
              codeBlock.create({ language: parsed.language }, codeContent),
            ];
            if (!hasTrailingText && !hasFollowingBlock) {
              insertedNodes.push(paragraph.create());
            }
            const slice = new Slice(Fragment.fromArray(insertedNodes), 0, 0);
            const transaction = view.state.tr
              .replaceSelection(slice)
              .setMeta("paste", true)
              .scrollIntoView();

            view.dispatch(transaction);
            event.preventDefault();
            debugCodeFormatting({
              action: "paste_fenced_code",
              codeLength: parsed.code.length,
              hasLanguage: parsed.hasLanguage,
            });
            return true;
          },
        },
      }),
    ];
  },
});

function parseCompleteFence(text: string): CompleteFence | null {
  if (!text) return null;

  const normalized = text.replace(/\r\n?/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  const lines = withoutFinalNewline.split("\n");
  if (lines.length < 2) return null;

  const opening = /^(?<fence>```|~~~)(?<language>[^\n]*)$/.exec(lines[0]!);
  if (!opening?.groups) return null;

  const fence = opening.groups["fence"];
  if (lines.at(-1) !== fence) return null;

  const language = opening.groups["language"]?.trim() ?? "";
  return {
    code: lines.slice(1, -1).join("\n"),
    hasLanguage: language.length > 0,
    language: language || null,
  };
}

function exitOnClosingFence(editor: Editor): boolean {
  if (editor.view.composing) return false;

  const { selection } = editor.state;
  const { $from } = selection;
  if (!selection.empty || $from.parent.type.name !== "codeBlock") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  const text = $from.parent.textContent;
  const lineStart = text.lastIndexOf("\n") + 1;
  const fence = text.slice(lineStart);
  if (fence !== "```" && fence !== "~~~") return false;

  const deleteFrom = $from.start() + (lineStart > 0 ? lineStart - 1 : 0);
  const handled = editor
    .chain()
    .command(({ tr }) => {
      tr.delete(deleteFrom, $from.pos);
      return true;
    })
    .exitCode()
    .run();

  if (handled) {
    debugCodeFormatting({ action: "exit_code_block", key: "Enter" });
  }
  return handled;
}

function unwrapInlineCode(editor: Editor, key: BoundaryKey): boolean {
  const { selection, schema } = editor.state;
  const { $from } = selection;
  const code = schema.marks["code"];
  if (!selection.empty || !code || !$from.parent.inlineContent) return false;

  const isAtBoundary =
    key === "Backspace"
      ? hasMark($from.nodeBefore, code) && !hasMark($from.nodeAfter, code)
      : !hasMark($from.nodeBefore, code) && hasMark($from.nodeAfter, code);
  if (!isAtBoundary) return false;

  const range = getMarkRange($from, code);
  if (!range) return false;

  editor.view.dispatch(
    editor.state.tr
      .removeMark(range.from, range.to, code)
      .removeStoredMark(code)
      .scrollIntoView(),
  );
  debugCodeFormatting({ action: "unwrap_inline_code", key });
  return true;
}

function hasMark(node: ProseMirrorNode | null, mark: MarkType): boolean {
  return node?.marks.some((candidate) => candidate.type === mark) ?? false;
}

function unwrapCodeBlock(editor: Editor, key: BoundaryKey): boolean {
  const { selection, schema } = editor.state;
  const { $from } = selection;
  const paragraph = schema.nodes["paragraph"];
  if (!selection.empty || !paragraph || !$from.parent.isTextblock) return false;

  const atBoundary =
    key === "Backspace"
      ? $from.parentOffset === 0
      : $from.parentOffset === $from.parent.content.size;
  if (!atBoundary) return false;

  const currentIsCode = $from.parent.type.name === "codeBlock";
  if (currentIsCode) {
    const converted = convertNodeToParagraph(
      editor,
      $from,
      $from.before(),
      paragraph,
      $from.index($from.depth - 1),
    );
    if (converted) {
      debugCodeFormatting({
        action: "unwrap_code_block",
        boundary: "current",
        key,
      });
    }
    return converted;
  }

  const currentStart = $from.before();
  const currentEnd = $from.after();
  const sibling =
    key === "Backspace"
      ? editor.state.doc.resolve(currentStart).nodeBefore
      : editor.state.doc.resolve(currentEnd).nodeAfter;
  if (sibling?.type.name !== "codeBlock") return false;

  const currentIndex = $from.index($from.depth - 1);
  const siblingIndex =
    key === "Backspace" ? currentIndex - 1 : currentIndex + 1;
  const siblingPosition =
    key === "Backspace" ? currentStart - sibling.nodeSize : currentEnd;
  const converted = convertNodeToParagraph(
    editor,
    $from,
    siblingPosition,
    paragraph,
    siblingIndex,
  );
  if (converted) {
    debugCodeFormatting({
      action: "unwrap_code_block",
      boundary: key === "Backspace" ? "previous" : "next",
      key,
    });
  }
  return converted;
}

function convertNodeToParagraph(
  editor: Editor,
  $cursor: ResolvedPos,
  position: number,
  paragraph: NodeType,
  index: number,
): boolean {
  const container = $cursor.node($cursor.depth - 1);
  if (!container.canReplaceWith(index, index + 1, paragraph)) return false;

  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(position, paragraph).scrollIntoView(),
  );
  return true;
}

function debugCodeFormatting(
  fields: Record<string, string | number | boolean>,
): void {
  logger.debug("prompt_editor.code_formatting", fields);
}
