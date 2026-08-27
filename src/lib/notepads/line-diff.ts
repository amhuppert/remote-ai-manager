/**
 * Pure line diff over two canonical notepad texts, for the history preview's
 * versus-previous and versus-current views. A real interleaved diff in
 * document order: changed runs render where they happened, with each removed
 * run directly before the added run that replaced it.
 */

export type NotepadDiffLineKind = "unchanged" | "added" | "removed";

export interface NotepadDiffLine {
  kind: NotepadDiffLineKind;
  text: string;
}

/**
 * Bounds the quadratic LCS table (~16MB, ≈2000×2000 changed lines). A span
 * past the bound is split on a common line near its middle — a unique one
 * when it exists, otherwise a repeated one aligned by occurrence ordinal —
 * and each half diffed recursively, so even edits at both ends of a very
 * large document stay local. A wholesale replacement (removed lines then
 * added lines) remains only for spans that share no line at all, where it is
 * the exact diff.
 */
const MAX_DIFF_CELLS = 4_000_000;

export function diffNotepadLines(from: string, to: string): NotepadDiffLine[] {
  return diffLines(
    from === "" ? [] : from.split("\n"),
    to === "" ? [] : to.split("\n"),
  );
}

function unchangedLine(text: string): NotepadDiffLine {
  return { kind: "unchanged", text };
}

/** Trim the shared prefix and suffix, then diff the changed span between. */
function diffLines(before: string[], after: string[]): NotepadDiffLine[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return [
    ...before.slice(0, prefix).map(unchangedLine),
    ...diffSpan(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
    ),
    ...before.slice(before.length - suffix).map(unchangedLine),
  ];
}

function wholesale(before: string[], after: string[]): NotepadDiffLine[] {
  return [
    ...before.map((text): NotepadDiffLine => ({ kind: "removed", text })),
    ...after.map((text): NotepadDiffLine => ({ kind: "added", text })),
  ];
}

interface DiffAnchor {
  beforeIndex: number;
  afterIndex: number;
}

/**
 * A common line near the span's middle to split on. A line occurring exactly
 * once on each side is the safest alignment point and is preferred. When no
 * line is unique (a large repeated interior, say), a repeated common line is
 * anchored instead by pairing the middle occurrence on the before side with
 * the same ordinal occurrence on the after side — order-preserving on both
 * sides, hence always a valid alignment. Null only when the spans share no
 * line at all.
 */
function middleAnchor(before: string[], after: string[]): DiffAnchor | null {
  const beforeIndices = new Map<string, number[]>();
  before.forEach((text, index) => {
    const list = beforeIndices.get(text);
    if (list) list.push(index);
    else beforeIndices.set(text, [index]);
  });
  const afterIndices = new Map<string, number[]>();
  after.forEach((text, index) => {
    if (!beforeIndices.has(text)) return;
    const list = afterIndices.get(text);
    if (list) list.push(index);
    else afterIndices.set(text, [index]);
  });

  const middle = before.length / 2;
  let bestUnique: DiffAnchor | null = null;
  let bestUniqueDistance = Infinity;
  let bestRepeated: DiffAnchor | null = null;
  let bestRepeatedDistance = Infinity;
  for (const [text, onAfter] of afterIndices) {
    const onBefore = beforeIndices.get(text);
    if (!onBefore) continue;
    if (onBefore.length === 1 && onAfter.length === 1) {
      const beforeIndex = onBefore[0] ?? 0;
      const distance = Math.abs(beforeIndex - middle);
      if (distance < bestUniqueDistance) {
        bestUniqueDistance = distance;
        bestUnique = { beforeIndex, afterIndex: onAfter[0] ?? 0 };
      }
    } else {
      const ordinal = Math.floor(
        (Math.min(onBefore.length, onAfter.length) - 1) / 2,
      );
      const beforeIndex = onBefore[ordinal] ?? 0;
      const distance = Math.abs(beforeIndex - middle);
      if (distance < bestRepeatedDistance) {
        bestRepeatedDistance = distance;
        bestRepeated = { beforeIndex, afterIndex: onAfter[ordinal] ?? 0 };
      }
    }
  }
  return bestUnique ?? bestRepeated;
}

/** Diff an already-trimmed span: LCS when it fits, anchor-split when not. */
function diffSpan(before: string[], after: string[]): NotepadDiffLine[] {
  if (before.length === 0 || after.length === 0) {
    return wholesale(before, after);
  }
  if (before.length * after.length > MAX_DIFF_CELLS) {
    const anchor = middleAnchor(before, after);
    if (anchor === null) return wholesale(before, after);
    return [
      ...diffLines(
        before.slice(0, anchor.beforeIndex),
        after.slice(0, anchor.afterIndex),
      ),
      unchangedLine(before[anchor.beforeIndex] ?? ""),
      ...diffLines(
        before.slice(anchor.beforeIndex + 1),
        after.slice(anchor.afterIndex + 1),
      ),
    ];
  }

  // Longest-common-subsequence table, filled bottom-up so the walk below can
  // stream the diff top-down in document order.
  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);
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

  const lines: NotepadDiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    const left = before[row];
    const right = after[column];
    if (left !== undefined && left === right) {
      lines.push({ kind: "unchanged", text: left });
      row += 1;
      column += 1;
      continue;
    }
    // On a tie, take the removal first so a replacement reads "was X, now Y".
    if (
      (table[(row + 1) * columns + column] ?? 0) >=
      (table[row * columns + column + 1] ?? 0)
    ) {
      if (left !== undefined) lines.push({ kind: "removed", text: left });
      row += 1;
      continue;
    }
    if (right !== undefined) lines.push({ kind: "added", text: right });
    column += 1;
  }
  for (; row < before.length; row += 1) {
    const text = before[row];
    if (text !== undefined) lines.push({ kind: "removed", text });
  }
  for (; column < after.length; column += 1) {
    const text = after[column];
    if (text !== undefined) lines.push({ kind: "added", text });
  }
  return lines;
}
