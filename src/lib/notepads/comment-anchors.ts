import { tryReanchorExact } from "@/lib/document-comments/anchor";
import { projectMarkdownPassage } from "@/components/markdown/markdown-source-map";

import type { NotepadCommentAnchor } from "./schemas";

/**
 * Where a comment's quoted passage sits in a notepad's CURRENT canonical text —
 * the same string `cctl notepad get` returns, reference XML and image tokens
 * included. Both readers of a comment share this one resolution: the agent
 * listing, so an agent can find the passage in what it reads, and the review
 * surface, so a highlight and its stale badge agree with the agent's view.
 *
 * Matching is exact and delegated to `tryReanchorExact`: a passage that no
 * longer matches, or that matches ambiguously, stays `stale` and is never
 * relocated onto different text.
 */

export type NotepadAnchorResolution =
  | { state: "anchored"; charStart: number; charEnd: number }
  | { state: "stale" };

/**
 * Surrounding context stored on an anchor. Matches the document-comment
 * anchor's window: it is stored context both domains carry and neither
 * consults when matching.
 */
export const NOTEPAD_ANCHOR_CONTEXT_CHARS = 32;

/** A fence opener or closer: up to three spaces, then three or more ` or ~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;

/** An indented code line: four spaces or a tab before any content. */
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/**
 * A fenced block runs to its matching closer — same character, at least as
 * long, nothing but whitespace after it — or to the end of the document when
 * the fence is never closed. Blank lines inside it are code, not a boundary.
 */
function fencedBlockEnd(
  lines: string[],
  start: number,
  opener: string,
): number {
  const marker = opener[0] ?? "`";
  for (let index = start + 1; index < lines.length; index++) {
    const match = FENCE_RE.exec(lines[index] ?? "");
    if (
      match &&
      (match[1] ?? "")[0] === marker &&
      (match[1] ?? "").length >= opener.length &&
      (match[2] ?? "").trim() === ""
    ) {
      return index;
    }
  }
  return lines.length - 1;
}

/**
 * An indented code block runs while its lines stay indented, absorbing the
 * blank lines between them; trailing blanks belong to the separation after the
 * block rather than to the block.
 */
function indentedBlockEnd(lines: string[], start: number): number {
  let end = start;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isBlank(line)) continue;
    if (!INDENTED_CODE_RE.test(line ?? "")) break;
    end = index;
  }
  return end;
}

/**
 * The block an anchor addresses, read out of the canonical text, beginning at
 * the anchor's 1-based line — the line the rendering stamped on the block the
 * comment was made in. This is the text the anchor's offsets were taken over.
 * Null when that line is blank or past the end: the block the comment was made
 * on is gone, which is staleness, not an error.
 *
 * Ordinary blocks are blank-line separated, but a code block is not — both a
 * fence and an indented block may contain blank lines while still rendering as
 * the single stamped block an anchor points at. Ending at the first blank line
 * there would truncate the block and report every passage below the blank line
 * stale, so the two code forms are read to their real end instead.
 */
export function notepadBlockTextAtLine(
  content: string,
  line: number,
): string | null {
  const lines = content.split("\n");
  const start = line - 1;
  if (start < 0 || start >= lines.length) return null;

  const first = lines[start];
  if (isBlank(first)) return null;

  const fence = FENCE_RE.exec(first ?? "");
  let end: number;
  if (fence) {
    end = fencedBlockEnd(lines, start, fence[1] ?? "");
  } else if (INDENTED_CODE_RE.test(first ?? "")) {
    end = indentedBlockEnd(lines, start);
  } else {
    end = start;
    while (end + 1 < lines.length && !isBlank(lines[end + 1])) end += 1;
  }

  return lines.slice(start, end + 1).join("\n");
}

export function resolveNotepadCommentAnchor(
  anchor: NotepadCommentAnchor,
  content: string,
): NotepadAnchorResolution {
  const result = tryReanchorExact(notepadPassageText(content, anchor), anchor);
  return result.status === "anchored"
    ? {
        state: "anchored",
        charStart: result.charStart,
        charEnd: result.charEnd,
      }
    : { state: "stale" };
}

export function notepadPassageText(
  content: string,
  anchor: Pick<NotepadCommentAnchor, "line" | "endBlock">,
): string | null {
  if (anchor.endBlock === undefined)
    return notepadBlockTextAtLine(content, anchor.line);
  const passage = projectMarkdownPassage(
    content,
    anchor.line,
    anchor.endBlock.line,
  );
  return passage === null
    ? null
    : content.slice(passage.sourceStart, passage.sourceEnd);
}

/**
 * Where the passage sits, phrased for someone reading the canonical text: the
 * heading it falls under plus the line it starts on. Content above the first
 * heading has no label, so the line stands alone rather than carrying an empty
 * one.
 */
export function describeNotepadCommentLocation(
  anchor: NotepadCommentAnchor,
): string {
  const heading = anchor.headingLabel.trim();
  const line = `line ${anchor.line}`;
  return heading === "" ? line : `${heading}, ${line}`;
}
