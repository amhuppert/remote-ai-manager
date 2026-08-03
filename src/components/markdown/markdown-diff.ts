import type { Element, ElementContent, Root, RootContent, Text } from "hast";

/**
 * Unified Markdown diff: the merge step that lets one rendered document carry
 * both its Markdown formatting and its revision colouring.
 *
 * A rendered diff cannot be assembled from pre-split before/after fragments —
 * Markdown only parses as a whole document. So the change is encoded *into* the
 * source before parsing: `buildMarkdownDiffSource` interleaves the two
 * revisions into one Markdown string whose changed spans are delimited by
 * private-use sentinels, and `rehypeDiffMarks` turns those sentinels back into
 * `<ins>`/`<del>` elements after parsing. Because the wrapping happens on the
 * parsed tree, a changed span inside emphasis, a link, or a list item keeps its
 * Markdown rendering and takes the diff colour on top of it.
 *
 * The merge is line-anchored, and marks are placed after a line's block prefix
 * (list bullet, heading hashes, blockquote arrows) and never inside a fenced
 * code block. That keeps the merged string a structurally valid document: the
 * sentinels only ever land in inline content, where they are inert to the
 * Markdown parser.
 */

export type DiffMarkKind = "added" | "removed";

/**
 * Unicode private-use characters. They carry no meaning to the Markdown parser
 * (it treats them as ordinary word characters), never occur in authored spec
 * prose, and survive parsing as literal text — which is what lets the rehype
 * pass find them again in the parsed tree.
 */
export const DIFF_MARK_OPEN: Record<DiffMarkKind, string> = {
  added: "\uE000",
  removed: "\uE002",
};

export const DIFF_MARK_CLOSE: Record<DiffMarkKind, string> = {
  added: "\uE001",
  removed: "\uE003",
};

/** hast property the rehype pass stamps so the renderer can style each mark. */
export const DIFF_KIND_PROPERTY = "dataDiff";

const MARK_CHARACTERS = new Set([
  DIFF_MARK_OPEN.added,
  DIFF_MARK_OPEN.removed,
  DIFF_MARK_CLOSE.added,
  DIFF_MARK_CLOSE.removed,
]);

/**
 * Leading syntax that must stay outside a mark: blockquote arrows, then one
 * list bullet or heading marker, then an optional GFM task checkbox. Marking a
 * line from column zero would swallow these and demote the line to a plain
 * paragraph.
 */
const BLOCKQUOTE_PREFIX = /^[ \t]*>[ \t]?/;
const BLOCK_MARKER_PREFIX =
  /^[ \t]*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+)?(?:\[[ xX]\][ \t]+)?/;

/** Fence openers/closers, including their allowed three-space indent. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Inline code is atomic: a mark boundary inside it would unbalance backticks. */
const TOKEN = /`+[^`]*`+[ \t]*|\S+[ \t]*|[ \t]+/g;

/**
 * Emphasis delimiters that open or close on a word are split off as their own
 * tokens. Left attached, a rewritten word carries its closing `**` into the
 * removed span and the replacement brings a second one, which leaves the merged
 * line with an unmatched delimiter run rendering as literal asterisks.
 */
const TOKEN_DELIMITERS = /^([*_~]*)(.*?)([*_~]*)([ \t]*)$/;

/**
 * Below this share of surviving text the two lines are different statements
 * rather than one edited statement, and a word-level merge reads as noise — so
 * they are shown as a removed line followed by an added line instead. The floor
 * is deliberately near zero: a rewritten line normally shares nothing, while an
 * edit of even a few words leaves far more than this behind.
 */
const MERGE_SIMILARITY_FLOOR = 0.15;

/** Guards the quadratic table on pathological input; see `diffSequences`. */
const MAX_DIFF_CELLS = 250_000;

interface DiffOp<T> {
  kind: "keep" | "remove" | "add";
  value: T;
  index: number;
}

interface DiffSegment {
  kind: DiffMarkKind | "unchanged";
  text: string;
}

interface SourceLine {
  text: string;
  fenced: boolean;
}

/**
 * Interleaves two Markdown revisions into one document whose changed spans are
 * sentinel-delimited. Either side may be `null` for an element that only exists
 * in one revision, in which case the whole body is marked.
 */
export function buildMarkdownDiffSource(
  before: string | null,
  after: string | null,
): string {
  if (before === null && after === null) return "";
  if (before === null) return after === null ? "" : markWhole(after, "added");
  if (after === null) return markWhole(before, "removed");
  if (before === after) return after;
  return mergeRevisions(before, after);
}

/** Rehype pass replacing the sentinels with `<ins>`/`<del>` elements. */
export function rehypeDiffMarks() {
  return (tree: Root): void => {
    transformRoot(tree, { mark: null });
  };
}

function markWhole(text: string, kind: DiffMarkKind): string {
  return sourceLines(text)
    .map((line) => (line.fenced ? line.text : markLine(line.text, kind)))
    .join("\n");
}

function mergeRevisions(before: string, after: string): string {
  const beforeLines = sourceLines(before);
  const afterLines = sourceLines(after);
  const merged: string[] = [];
  let pendingRemoved: SourceLine[] = [];
  let pendingAdded: SourceLine[] = [];

  function flush(): void {
    merged.push(...mergeLineRuns(pendingRemoved, pendingAdded));
    pendingRemoved = [];
    pendingAdded = [];
  }

  for (const op of diffSequences(
    beforeLines.map((line) => line.text),
    afterLines.map((line) => line.text),
  )) {
    if (op.kind === "keep") {
      flush();
      merged.push(op.value);
      continue;
    }
    const source = op.kind === "remove" ? beforeLines : afterLines;
    const line = source[op.index];
    if (line === undefined) continue;
    if (op.kind === "remove") pendingRemoved.push(line);
    else pendingAdded.push(line);
  }
  flush();

  return merged.join("\n");
}

/**
 * Renders one removed run against the added run that replaced it. Lines are
 * paired positionally: a pair that still reads as the same statement merges
 * into a single word-level diff, everything else stays on its own line.
 */
function mergeLineRuns(
  removedLines: SourceLine[],
  addedLines: SourceLine[],
): string[] {
  const merged: string[] = [];
  const paired = Math.min(removedLines.length, addedLines.length);

  for (let index = 0; index < paired; index += 1) {
    const removed = removedLines[index];
    const added = addedLines[index];
    if (removed === undefined || added === undefined) continue;
    // A fenced code line cannot carry sentinels — they would render as literal
    // characters inside the code — so the current revision stands uncoloured.
    if (removed.fenced || added.fenced) {
      merged.push(added.text);
      continue;
    }
    merged.push(...mergeLinePair(removed.text, added.text));
  }

  for (let index = paired; index < removedLines.length; index += 1) {
    const line = removedLines[index];
    // Dropped outright: a removed fenced line or a removed structural line has
    // no counterpart in the current revision, and showing it unmarked would
    // read as content that is still there.
    if (line === undefined || line.fenced || !hasWords(lineContent(line.text)))
      continue;
    merged.push(markLine(line.text, "removed"));
  }

  for (let index = paired; index < addedLines.length; index += 1) {
    const line = addedLines[index];
    if (line === undefined) continue;
    merged.push(line.fenced ? line.text : markLine(line.text, "added"));
  }

  return merged;
}

function mergeLinePair(before: string, after: string): string[] {
  const prefix = linePrefix(after);
  const beforeContent = lineContent(before);
  const afterContent = lineContent(after);
  if (!hasWords(beforeContent) || !hasWords(afterContent)) return [after];

  const segments = diffTokens(beforeContent, afterContent);
  if (mergedShare(segments) < MERGE_SIMILARITY_FLOOR) {
    return [markLine(before, "removed"), markLine(after, "added")];
  }
  return [
    prefix +
      segments
        .map((segment) =>
          segment.kind === "unchanged" ? segment.text : mark(segment),
        )
        .join(""),
  ];
}

function mark(segment: DiffSegment): string {
  if (segment.kind === "unchanged") return segment.text;
  return `${DIFF_MARK_OPEN[segment.kind]}${segment.text}${DIFF_MARK_CLOSE[segment.kind]}`;
}

function markLine(line: string, kind: DiffMarkKind): string {
  const content = lineContent(line);
  if (!hasWords(content)) return line;
  return linePrefix(line) + mark({ kind, text: content });
}

function linePrefix(line: string): string {
  let offset = 0;
  for (;;) {
    const quote = BLOCKQUOTE_PREFIX.exec(line.slice(offset));
    if (quote === null) break;
    offset += quote[0].length;
  }
  const marker = BLOCK_MARKER_PREFIX.exec(line.slice(offset));
  return line.slice(0, offset + (marker?.[0].length ?? 0));
}

function lineContent(line: string): string {
  return line.slice(linePrefix(line).length);
}

/**
 * Table delimiter rows, thematic breaks, and setext underlines carry no words.
 * Marking them would turn structure into prose, and there is nothing to read in
 * them anyway.
 */
function hasWords(content: string): boolean {
  return /[\p{L}\p{N}]/u.test(content);
}

function mergedShare(segments: DiffSegment[]): number {
  let unchanged = 0;
  let total = 0;
  for (const segment of segments) {
    const weight = segment.text.trim().length;
    total += weight;
    if (segment.kind === "unchanged") unchanged += weight;
  }
  return total === 0 ? 1 : unchanged / total;
}

function sourceLines(text: string): SourceLine[] {
  const lines = text.split("\n");
  const flags = fenceFlags(lines);
  return lines.map((line, index) => ({
    text: line,
    fenced: flags[index] ?? false,
  }));
}

function fenceFlags(lines: string[]): boolean[] {
  let openedWith: string | null = null;
  return lines.map((line) => {
    const fence = FENCE_LINE.exec(line)?.[1];
    if (openedWith === null) {
      if (fence === undefined) return false;
      openedWith = fence;
      return true;
    }
    // A fence closes only on the character it opened with, and never on a
    // shorter run — the same rule the parser applies.
    if (
      fence !== undefined &&
      fence.length >= openedWith.length &&
      fence[0] === openedWith[0]
    ) {
      openedWith = null;
    }
    return true;
  });
}

function diffTokens(before: string, after: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const op of diffSequences(tokenize(before), tokenize(after))) {
    appendSegment(
      segments,
      op.kind === "keep"
        ? "unchanged"
        : op.kind === "remove"
          ? "removed"
          : "added",
      op.value,
    );
  }
  return orderedSegments(segments);
}

/**
 * Removals read before the insertions that replace them, so a merged line scans
 * as "was X, now Y" rather than alternating mid-phrase.
 */
function orderedSegments(segments: DiffSegment[]): DiffSegment[] {
  const ordered: DiffSegment[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    if (current === undefined) continue;
    if (current.kind === "added" && next?.kind === "removed") {
      appendSegment(ordered, next.kind, next.text);
      index += 1;
    }
    appendSegment(ordered, current.kind, current.text);
  }
  return ordered;
}

function appendSegment(
  segments: DiffSegment[],
  kind: DiffSegment["kind"],
  text: string,
): void {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

function tokenize(value: string): string[] {
  return (value.match(TOKEN) ?? []).flatMap(splitDelimiters);
}

function splitDelimiters(token: string): string[] {
  if (token.startsWith("`")) return [token];
  const match = TOKEN_DELIMITERS.exec(token);
  if (match === null) return [token];
  const parts = [match[1] ?? "", match[2] ?? "", match[3] ?? ""].filter(
    (part) => part.length > 0,
  );
  const last = parts[parts.length - 1];
  if (last === undefined) return [token];
  parts[parts.length - 1] = last + (match[4] ?? "");
  return parts;
}

/**
 * Longest-common-subsequence diff. The quadratic table is bounded: past
 * `MAX_DIFF_CELLS` the two sides are reported as a wholesale replacement, which
 * the caller renders as a removed line followed by an added line.
 */
function diffSequences<T>(before: T[], after: T[]): DiffOp<T>[] {
  if (before.length * after.length > MAX_DIFF_CELLS) {
    return [
      ...before.map(
        (value, index): DiffOp<T> => ({
          kind: "remove",
          value,
          index,
        }),
      ),
      ...after.map(
        (value, index): DiffOp<T> => ({ kind: "add", value, index }),
      ),
    ];
  }

  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        before[row] === after[column]
          ? (table[(row + 1) * columns + column + 1] ?? 0) + 1
          : Math.max(
              table[(row + 1) * columns + column] ?? 0,
              table[row * columns + column + 1] ?? 0,
            );
    }
  }

  const ops: DiffOp<T>[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    const left = before[row];
    const right = after[column];
    if (left !== undefined && left === right) {
      ops.push({ kind: "keep", value: left, index: column });
      row += 1;
      column += 1;
      continue;
    }
    if (
      (table[(row + 1) * columns + column] ?? 0) >=
      (table[row * columns + column + 1] ?? 0)
    ) {
      if (left !== undefined)
        ops.push({ kind: "remove", value: left, index: row });
      row += 1;
      continue;
    }
    if (right !== undefined)
      ops.push({ kind: "add", value: right, index: column });
    column += 1;
  }
  for (; row < before.length; row += 1) {
    const value = before[row];
    if (value !== undefined) ops.push({ kind: "remove", value, index: row });
  }
  for (; column < after.length; column += 1) {
    const value = after[column];
    if (value !== undefined) ops.push({ kind: "add", value, index: column });
  }
  return ops;
}

interface MarkState {
  mark: DiffMarkKind | null;
}

function transformRoot(root: Root, state: MarkState): void {
  root.children = root.children.flatMap((child) => transformNode(child, state));
}

function transformElement(element: Element, state: MarkState): void {
  element.children = element.children.flatMap((child) =>
    transformNode(child, state),
  );
}

function transformNode<T extends RootContent>(
  node: T,
  state: MarkState,
): (T | Element | Text)[] {
  if (node.type === "text") return splitMarkedText(node.value, state);
  if (node.type === "element") transformElement(node, state);
  return [node];
}

/**
 * Splits one text node on the sentinels, wrapping the spans between an opening
 * and a closing sentinel. The mark state is carried across nodes because a
 * changed span may cover inline Markdown — the opening sentinel can sit in one
 * text node and the closing one in a later sibling of an `<em>` between them.
 */
function splitMarkedText(value: string, state: MarkState): (Element | Text)[] {
  const nodes: (Element | Text)[] = [];
  let buffer = "";

  function flush(): void {
    if (buffer.length === 0) return;
    nodes.push(
      state.mark === null ? text(buffer) : markElement(state.mark, buffer),
    );
    buffer = "";
  }

  for (const character of value) {
    if (!MARK_CHARACTERS.has(character)) {
      buffer += character;
      continue;
    }
    flush();
    if (character === DIFF_MARK_OPEN.added) state.mark = "added";
    else if (character === DIFF_MARK_OPEN.removed) state.mark = "removed";
    else state.mark = null;
  }
  flush();

  return nodes;
}

function text(value: string): Text {
  return { type: "text", value };
}

function markElement(kind: DiffMarkKind, value: string): Element {
  const child: ElementContent = text(value);
  return {
    type: "element",
    tagName: kind === "added" ? "ins" : "del",
    properties: { [DIFF_KIND_PROPERTY]: kind },
    children: [child],
  };
}
