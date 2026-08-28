import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  findNextWordEnd,
  findPreviousWordStart,
} from "@/lib/multiline/shortcuts";

export interface TerminalHotkeysOptions {
  /**
   * Invoked when the user presses the submit chord (Mod-Enter — Ctrl-Enter on
   * Linux/Windows, Cmd-Enter on macOS). Plain Enter is no longer treated as a
   * submit; it falls through to the default keymap (paragraph split).
   *
   * Null in surfaces with nothing to submit (the notepad editor): Mod-Enter is
   * then left to the default keymap rather than swallowed.
   */
  onSubmit: (() => void) | null;
}

/**
 * Tiptap extension that adds readline / terminal-style keybindings to the
 * prompt editor:
 *
 * - Ctrl-A / Ctrl-E → jump to start / end of the current paragraph (line)
 * - Ctrl-U / Ctrl-K → kill from cursor to start / end of the current paragraph
 * - Ctrl-W          → delete the previous word (whitespace-bounded)
 * - Alt-B / Alt-F   → move cursor back / forward by one word
 * - Alt-D           → delete the next word (whitespace-bounded)
 * - Mod-Enter       → submit (overrides hardBreak's default Mod-Enter binding)
 *
 * Word boundaries are whitespace-only to match GNU readline (Bash / zsh
 * default), not the Unicode word segmentation that browsers use natively.
 *
 * "Line" is interpreted as the current ProseMirror textblock (paragraph). A
 * terminal shell input is single-line; mapping line-ops to paragraph keeps the
 * semantics natural in the multi-line prompt without depending on visual
 * line-wrap measurements (which jsdom can't compute).
 */
export const TerminalHotkeys = Extension.create<TerminalHotkeysOptions>({
  name: "terminalHotkeys",

  // Bump above the default 100 so our keymap merges *after* StarterKit's
  // hardBreak (which also binds Mod-Enter); the later binding wins.
  priority: 1000,

  addOptions() {
    return { onSubmit: null };
  },

  addKeyboardShortcuts() {
    return {
      "Ctrl-a": () => moveToLineStart(this.editor),
      "Ctrl-e": () => moveToLineEnd(this.editor),
      "Ctrl-u": () => killToLineStart(this.editor),
      "Ctrl-k": () => killToLineEnd(this.editor),
      "Ctrl-w": () => deleteWordBackward(this.editor),
      "Alt-b": () => moveWordBackward(this.editor),
      "Alt-f": () => moveWordForward(this.editor),
      "Alt-d": () => deleteWordForward(this.editor),
      "Mod-Enter": () => {
        const onSubmit = this.options.onSubmit;
        if (onSubmit === null) return false;
        if (this.editor.view.composing) return false;
        onSubmit();
        return true;
      },
    };
  },
});

function moveToLineStart(editor: Editor): boolean {
  const { state } = editor;
  const { $head } = state.selection;
  const target = $head.start();
  return setCursor(editor, target);
}

function moveToLineEnd(editor: Editor): boolean {
  const { state } = editor;
  const { $head } = state.selection;
  const target = $head.end();
  return setCursor(editor, target);
}

function killToLineStart(editor: Editor): boolean {
  const { state } = editor;
  const { $head } = state.selection;
  const start = $head.start();
  const head = state.selection.head;
  if (head <= start) return true;
  editor.view.dispatch(state.tr.delete(start, head).scrollIntoView());
  return true;
}

function killToLineEnd(editor: Editor): boolean {
  const { state } = editor;
  const { $head } = state.selection;
  const end = $head.end();
  const head = state.selection.head;
  if (head >= end) return true;
  editor.view.dispatch(state.tr.delete(head, end).scrollIntoView());
  return true;
}

function moveWordBackward(editor: Editor): boolean {
  const ctx = blockContext(editor);
  const newOffset = findPreviousWordStart(ctx.text, ctx.offset);
  if (newOffset === ctx.offset) return true;
  return setCursor(editor, ctx.blockStart + newOffset);
}

function moveWordForward(editor: Editor): boolean {
  const ctx = blockContext(editor);
  const newOffset = findNextWordEnd(ctx.text, ctx.offset);
  if (newOffset === ctx.offset) return true;
  return setCursor(editor, ctx.blockStart + newOffset);
}

function deleteWordBackward(editor: Editor): boolean {
  const ctx = blockContext(editor);
  const newOffset = findPreviousWordStart(ctx.text, ctx.offset);
  if (newOffset === ctx.offset) return true;
  const { state } = editor;
  editor.view.dispatch(
    state.tr
      .delete(ctx.blockStart + newOffset, ctx.blockStart + ctx.offset)
      .scrollIntoView(),
  );
  return true;
}

function deleteWordForward(editor: Editor): boolean {
  const ctx = blockContext(editor);
  const newOffset = findNextWordEnd(ctx.text, ctx.offset);
  if (newOffset === ctx.offset) return true;
  const { state } = editor;
  editor.view.dispatch(
    state.tr
      .delete(ctx.blockStart + ctx.offset, ctx.blockStart + newOffset)
      .scrollIntoView(),
  );
  return true;
}

function blockContext(editor: Editor): {
  text: string;
  offset: number;
  blockStart: number;
} {
  const { state } = editor;
  const { $head } = state.selection;
  const blockStart = $head.start();
  // textBetween with "\ufffc" placeholder ensures non-text inline leaves
  // (e.g. imageMarker chips) consume one position so the offset stays aligned
  // with $head.parentOffset.
  const text = $head.parent.textBetween(
    0,
    $head.parent.content.size,
    undefined,
    "\ufffc",
  );
  const offset = $head.parentOffset;
  return { text, offset, blockStart };
}

function setCursor(editor: Editor, pos: number): boolean {
  const { state } = editor;
  if (state.selection.from === pos && state.selection.to === pos) return true;
  editor.view.dispatch(
    state.tr
      .setSelection(TextSelection.create(state.doc, pos))
      .scrollIntoView(),
  );
  return true;
}
