export type MultilineShortcut =
  | "line-start"
  | "line-end"
  | "delete-line-start"
  | "delete-line-end"
  | "delete-word-backward"
  | "word-backward"
  | "word-forward"
  | "delete-word-forward"
  | "submit";

export interface ShortcutKeyEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface TextSelection {
  start: number;
  end: number;
}

export interface TextareaShortcutResult {
  value: string;
  selection: TextSelection;
}

export function insertTextAtActiveEdge(
  value: string,
  selection: TextSelection,
  direction: "forward" | "backward" | "none",
  text: string,
): TextareaShortcutResult {
  const activeEdge = direction === "backward" ? selection.start : selection.end;
  const position = clamp(activeEdge, 0, value.length);
  const cursor = position + text.length;
  return {
    value: `${value.slice(0, position)}${text}${value.slice(position)}`,
    selection: { start: cursor, end: cursor },
  };
}

function isPlainModifier(event: ShortcutKeyEvent): boolean {
  return !event.altKey && !event.metaKey && !event.shiftKey;
}

function normalizedKey(event: ShortcutKeyEvent): string {
  return event.key.toLowerCase();
}

export function getMultilineShortcut(
  event: ShortcutKeyEvent,
  isMac: boolean,
): MultilineShortcut | null {
  if (event.isComposing) return null;

  if (event.key === "Enter") {
    const usesSubmitModifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    return usesSubmitModifier && !event.altKey && !event.shiftKey
      ? "submit"
      : null;
  }

  const key = normalizedKey(event);
  if (event.ctrlKey && isPlainModifier(event)) {
    switch (key) {
      case "a":
        return "line-start";
      case "e":
        return "line-end";
      case "u":
        return "delete-line-start";
      case "k":
        return "delete-line-end";
      case "w":
        return "delete-word-backward";
      default:
        return null;
    }
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    switch (key) {
      case "b":
        return "word-backward";
      case "f":
        return "word-forward";
      case "d":
        return "delete-word-forward";
      default:
        return null;
    }
  }

  return null;
}

export function findPreviousWordStart(text: string, offset: number): number {
  let index = clamp(offset, 0, text.length);
  while (index > 0 && isWhitespace(text[index - 1]!)) index -= 1;
  while (index > 0 && !isWhitespace(text[index - 1]!)) index -= 1;
  return index;
}

export function findNextWordEnd(text: string, offset: number): number {
  let index = clamp(offset, 0, text.length);
  while (index < text.length && isWhitespace(text[index]!)) index += 1;
  while (index < text.length && !isWhitespace(text[index]!)) index += 1;
  return index;
}

function currentLineBounds(
  value: string,
  position: number,
): {
  start: number;
  end: number;
} {
  const offset = clamp(position, 0, value.length);
  const start = offset === 0 ? 0 : value.lastIndexOf("\n", offset - 1) + 1;
  const nextBreak = value.indexOf("\n", offset);
  return { start, end: nextBreak === -1 ? value.length : nextBreak };
}

function replaceRange(
  value: string,
  from: number,
  to: number,
): TextareaShortcutResult {
  const nextValue = value.slice(0, from) + value.slice(to);
  return { value: nextValue, selection: { start: from, end: from } };
}

function cursorPosition(
  selection: TextSelection,
  length: number,
  direction: "forward" | "backward" | "none",
): number {
  return clamp(
    direction === "backward" ? selection.start : selection.end,
    0,
    length,
  );
}

export function applyTextareaShortcut(
  value: string,
  selection: TextSelection,
  shortcut: Exclude<MultilineShortcut, "submit">,
  direction: "forward" | "backward" | "none" = "none",
): TextareaShortcutResult {
  const cursor = cursorPosition(selection, value.length, direction);
  const line = currentLineBounds(value, cursor);
  const lineText = value.slice(line.start, line.end);
  const lineOffset = cursor - line.start;

  switch (shortcut) {
    case "line-start":
      return { value, selection: { start: line.start, end: line.start } };
    case "line-end":
      return { value, selection: { start: line.end, end: line.end } };
    case "delete-line-start":
      return replaceRange(value, line.start, cursor);
    case "delete-line-end":
      return replaceRange(value, cursor, line.end);
    case "delete-word-backward": {
      const from = line.start + findPreviousWordStart(lineText, lineOffset);
      return replaceRange(value, from, cursor);
    }
    case "word-backward": {
      const position = line.start + findPreviousWordStart(lineText, lineOffset);
      return { value, selection: { start: position, end: position } };
    }
    case "word-forward": {
      const position = line.start + findNextWordEnd(lineText, lineOffset);
      return { value, selection: { start: position, end: position } };
    }
    case "delete-word-forward": {
      const to = line.start + findNextWordEnd(lineText, lineOffset);
      return replaceRange(value, cursor, to);
    }
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}
