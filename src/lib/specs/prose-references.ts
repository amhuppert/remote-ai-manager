import {
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
  type ParsedElementHandle,
} from "./handles";

export interface ProseHandleReference {
  /** The text as it appears in the prose, e.g. `R1.2` or `native-sdd/R1`. */
  token: string;
  /** The element the token addresses, resolved against the context slug. */
  handle: ParsedElementHandle;
}

/**
 * A masking scanner over Markdown prose, deliberately not a Markdown parser: it
 * renders nothing and reads no inline structure. It blanks the regions where a
 * handle-shaped run of characters is not a reference — fenced code, inline code
 * spans, autolinks, raw URLs, and link destinations — and then matches handle
 * tokens in what remains, at lexical boundaries, through the canonical grammar
 * in `handles.ts`.
 *
 * Indented (four-space) code is deliberately NOT masked. Telling it apart from
 * an indented list continuation needs block context, which is the parser this
 * scanner refuses to become; the fence and inline-code masks are the documented
 * way to mention a literal token without asserting a reference.
 */

/** Blanks a span while preserving length and line structure. */
function blank(characters: string[], start: number, end: number): void {
  for (
    let index = start;
    index < end && index < characters.length;
    index += 1
  ) {
    if (characters[index] !== "\n") {
      characters[index] = " ";
    }
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Markdown allows whitespace between `](` and the destination. */
function isWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

/**
 * Fenced blocks are the only line-oriented mask, so they run first: blanking
 * them removes the backticks a fence shares with the inline-code scan below.
 */
function maskFencedBlocks(characters: string[], text: string): void {
  let lineStart = 0;
  let fence: { marker: string; length: number } | null = null;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);

    const run = FENCE_OPEN.exec(line)?.[1];

    if (fence === null) {
      if (run !== undefined) {
        fence = { marker: run.slice(0, 1), length: run.length };
        blank(characters, lineStart, lineEnd);
      }
    } else {
      blank(characters, lineStart, lineEnd);
      if (
        run !== undefined &&
        run.startsWith(fence.marker) &&
        run.length >= fence.length &&
        line.slice(line.indexOf(run) + run.length).trim() === ""
      ) {
        fence = null;
      }
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }
}

/**
 * A backtick run opens a code span only when a run of the same length closes
 * it; an unmatched run is ordinary prose and stays scannable.
 */
function maskCodeSpans(characters: string[], text: string): void {
  // A run length that found no closer cannot find one later either — the search
  // space only shrinks — so remembering it keeps a field full of unmatched
  // backticks from re-scanning to the end once per run.
  const unclosedLengths = new Set<number>();
  let index = 0;

  while (index < text.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }

    const openStart = index;
    while (index < text.length && characters[index] === "`") index += 1;
    const runLength = index - openStart;
    if (unclosedLengths.has(runLength)) continue;

    let cursor = index;
    let closeEnd = -1;
    while (cursor < text.length) {
      if (characters[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const closeStart = cursor;
      while (cursor < text.length && characters[cursor] === "`") cursor += 1;
      if (cursor - closeStart === runLength) {
        closeEnd = cursor;
        break;
      }
    }

    if (closeEnd === -1) {
      unclosedLengths.add(runLength);
      continue;
    }
    blank(characters, openStart, closeEnd);
    index = closeEnd;
  }
}

/**
 * Scheme runs are length-bounded on purpose. Unbounded (`[A-Za-z0-9+.-]*`)
 * they re-scan to end of field at every start position that is not a URL, so a
 * long ordinary paragraph costs quadratic time — 80KB of prose took ~14s and
 * blew a CLI read budget. No real scheme approaches this bound.
 */
const SCHEME = "[A-Za-z][A-Za-z0-9+.-]{0,31}";

const URL_MASKS = [
  /* Autolink: <https://…> or <someone@example.dev>. */
  new RegExp(`<${SCHEME}:[^<>\\s]*>|<[^<>\\s@]+@[^<>\\s]+>`, "g"),
  /* GFM email autolink literal: someone@example.dev. */
  /(?<![A-Za-z0-9+._\/-])[A-Za-z0-9+._-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z0-9_-]*[A-Za-z](?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g,
  /* Link reference definition: the whole destination line after the label. */
  /^ {0,3}\[[^\]\n]*\]:.*$/gm,
  /* Raw URL, scheme-qualified or www-prefixed. */
  new RegExp(`${SCHEME}://[^\\s<>]+|\\bwww\\.[^\\s<>]+`, "g"),
];

/**
 * Inline link destinations, masked in ONE forward pass over the field.
 *
 * Only the `(…)` run is blanked; the preceding link text stays scannable,
 * because a handle written into link text is prose asserting a reference.
 *
 * The pass keeps a stack of open parentheses, marking those opened directly
 * after a `]`. A `)` closes the innermost one, and closing a marked frame masks
 * it. That structure is what makes the scan linear: earlier work is never
 * redone, so an unclosed run costs one character rather than a fresh scan to
 * end of field. A restart-per-`](` scanner needs a cost guard to stay out of
 * quadratic time, and any such guard eventually has to stop masking — silently
 * exposing every destination after it, which is exactly the false finding this
 * mask exists to prevent. Correctness here is not something a cost guard may
 * trade away, so the design removes the need for one.
 *
 * Two Markdown rules the structure has to respect:
 *
 * - A pointy-bracketed destination is delimited by `>` and its parentheses need
 *   NOT balance, so it is consumed whole before any of them are counted;
 *   `[d](<docs/(R9>)` is a valid link. A malformed one is not a link at all, so
 *   its frame is unmarked and its closing paren masks nothing.
 * - A title is separated from the destination by whitespace, so a quote WITHOUT
 *   that separation is an ordinary destination character — `[d](docs/it's(R9))`
 *   is a valid destination, not an unterminated title.
 *
 * Markdown bounds neither a destination nor a title, and neither does this scan.
 */
interface DestinationFrame {
  readonly position: number;
  /** Whether closing this frame masks it — false once proven not to be a link. */
  isLink: boolean;
  /** The link frame whose bare destination contains this parenthesis frame. */
  destinationOwner?: DestinationFrame;
  /** Whether the bare or pointy destination has begun. */
  destinationStarted: boolean;
  /** Whitespace or a pointy close means only a title or the frame close may follow. */
  separatorSeen: boolean;
}

/** Index just past `>`, or -1 when this is not a valid pointy destination. */
function endOfPointyDestination(
  characters: string[],
  text: string,
  start: number,
): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    const character = characters[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    // A pointy destination admits neither a line ending nor a nested `<`, so
    // either one means this was never a link.
    if (character === "\n" || character === "<") return -1;
    if (character === ">") return cursor + 1;
    cursor += 1;
  }
  return -1;
}

/** Index just past the closing quote, or -1 when the title never closes. */
function endOfQuotedTitle(
  characters: string[],
  text: string,
  start: number,
): number {
  const quote = characters[start];
  let cursor = start + 1;
  while (cursor < text.length) {
    const character = characters[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) return cursor + 1;
    cursor += 1;
  }
  return -1;
}

function maskLinkDestinations(characters: string[], text: string): void {
  const frames: DestinationFrame[] = [];
  const labelOpenings: number[] = [];
  let cursor = 0;
  let lastLabelCloser = -1;
  let previousWasWhitespace = true;

  while (cursor < text.length) {
    const character = characters[cursor];

    if (character === "\\") {
      const destinationOwner = frames[frames.length - 1]?.destinationOwner;
      if (destinationOwner?.isLink === true) {
        if (destinationOwner.separatorSeen) {
          destinationOwner.isLink = false;
        } else {
          destinationOwner.destinationStarted = true;
        }
      }
      cursor += 2;
      lastLabelCloser = -1;
      previousWasWhitespace = false;
      continue;
    }

    if (character === "[") {
      labelOpenings.push(cursor);
      cursor += 1;
      lastLabelCloser = -1;
      previousWasWhitespace = false;
      continue;
    }

    if (character === "]") {
      lastLabelCloser = labelOpenings.pop() === undefined ? -1 : cursor;
      cursor += 1;
      previousWasWhitespace = false;
      continue;
    }

    if (character === "(") {
      const enclosingDestination = frames[frames.length - 1]?.destinationOwner;
      if (enclosingDestination?.isLink === true) {
        if (enclosingDestination.separatorSeen) {
          enclosingDestination.isLink = false;
        } else {
          enclosingDestination.destinationStarted = true;
        }
      }
      const frame: DestinationFrame = {
        position: cursor,
        isLink: lastLabelCloser === cursor - 1,
        destinationStarted: false,
        separatorSeen: false,
      };
      frame.destinationOwner = frame.isLink ? frame : enclosingDestination;
      frames.push(frame);
      cursor += 1;
      lastLabelCloser = -1;
      previousWasWhitespace = false;
      if (!frame.isLink) continue;

      let lookahead = cursor;
      while (lookahead < text.length && isWhitespace(characters[lookahead])) {
        lookahead += 1;
      }
      if (characters[lookahead] !== "<") continue;

      const afterPointy = endOfPointyDestination(characters, text, lookahead);
      if (afterPointy === -1) {
        frame.isLink = false;
        continue;
      }
      frame.destinationStarted = true;
      frame.separatorSeen = true;
      cursor = afterPointy;
      continue;
    }

    if (character === ")") {
      const frame = frames.pop();
      if (frame !== undefined && frame.isLink) {
        blank(characters, frame.position, cursor + 1);
      }
      cursor += 1;
      lastLabelCloser = -1;
      previousWasWhitespace = false;
      continue;
    }

    if (
      (character === '"' || character === "'") &&
      previousWasWhitespace &&
      frames[frames.length - 1]?.isLink === true
    ) {
      const afterTitle = endOfQuotedTitle(characters, text, cursor);
      if (afterTitle !== -1) {
        let next = afterTitle;
        while (next < text.length && isWhitespace(characters[next])) {
          next += 1;
        }
        if (characters[next] !== ")") {
          const frame = frames[frames.length - 1];
          if (frame !== undefined) frame.isLink = false;
        }
        cursor = afterTitle;
        lastLabelCloser = -1;
        previousWasWhitespace = false;
        continue;
      }
      const frame = frames[frames.length - 1];
      if (frame !== undefined) frame.isLink = false;
    }

    const whitespace = isWhitespace(character);
    const frame = frames[frames.length - 1]?.destinationOwner;
    if (frame?.isLink === true) {
      if (whitespace) {
        if (frame.destinationStarted) frame.separatorSeen = true;
      } else if (frame.separatorSeen) {
        frame.isLink = false;
      } else {
        frame.destinationStarted = true;
      }
    }
    lastLabelCloser = -1;
    previousWasWhitespace = whitespace;
    cursor += 1;
  }
}

function maskLinksAndUrls(characters: string[], text: string): void {
  maskLinkDestinations(characters, text);
  for (const pattern of URL_MASKS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      blank(characters, match.index, match.index + match[0].length);
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
}

/**
 * Candidate tokens, loose on the counter so the canonical grammar — not this
 * regex — decides that `R0` and `R01` are not handles.
 *
 * The boundaries carry the false-positive contract. A preceding word, `-`, `/`,
 * or `.` character means the run belongs to something larger (`PR1`, `FOO-R3`,
 * `docs/designs/R3`), and a following word character or `.<digit>` means the
 * same (`R10x`, `R1.2.3`) — while a sentence-final `.` still terminates a
 * token.
 */
const CANDIDATE_TOKEN =
  /(?<![A-Za-z0-9_\-/.])((?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?(?:R\d+(?:\.\d+)?|[DTQA]\d+))(?![A-Za-z0-9_])(?!\.\d)/g;

export function extractProseHandleReferences(
  text: string,
  contextSlug: string,
): ProseHandleReference[] {
  // Spec slugs are canonical by construction; a value the grammar cannot admit
  // could only ever produce unresolvable handles, so it yields no references
  // rather than a field-wide sweep of false findings.
  if (!specSlugSchema.safeParse(contextSlug).success) return [];

  // Split by UTF-16 code unit, not code point: every mask below positions
  // itself with a regex `index`, and an astral character (an emoji in prose)
  // would otherwise shift the mask against the text it is meant to blank.
  const characters = text.split("");
  maskFencedBlocks(characters, text);
  const afterFences = characters.join("");
  maskCodeSpans(characters, afterFences);
  maskLinksAndUrls(characters, characters.join(""));
  const scannable = characters.join("");

  const references: ProseHandleReference[] = [];
  CANDIDATE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CANDIDATE_TOKEN.exec(scannable)) !== null) {
    const token = match[1];
    if (token === undefined) continue;
    const separatorIndex = token.indexOf("/");
    // A foreign slug is recognized and skipped: resolving it needs a read of
    // another spec, which lint's input model does not carry.
    if (
      separatorIndex !== -1 &&
      token.slice(0, separatorIndex) !== contextSlug
    ) {
      continue;
    }
    if (!isWellFormedElementHandle(token, contextSlug)) continue;
    references.push({ token, handle: parseElementHandle(token, contextSlug) });
  }

  return references;
}
