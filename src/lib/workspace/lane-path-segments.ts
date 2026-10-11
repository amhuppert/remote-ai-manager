/**
 * The path discipline every lane write envelope composes its directories from.
 *
 * Both composers build filesystem paths out of authored ids (execution,
 * context, assignment), and both then have to prove the result still names a
 * child of the directory it was meant to name. The rules are identical because
 * the threat is identical — an authored id able to carry a separator or a
 * traversal segment would relocate the one directory a lane may write to — so
 * they live here once rather than in each composer.
 */

import path from "node:path";

/**
 * Code units that survive into a segment unchanged. Deliberately excludes `.`,
 * so no id can produce `.` or `..` — a segment that names traversal rather than
 * a child. `_` is excluded because it is the escape marker below.
 *
 * Uppercase letters are excluded for a different reason: a filesystem, not a
 * string comparison, is what has to tell two segments apart. macOS formats
 * case-insensitive volumes by default, so `ctx-1` and `CTX-1` are one directory
 * there no matter how carefully the encoding kept them distinct as strings.
 * Escaping uppercase keeps the ENTIRE image within `[a-z0-9_-]`, and no
 * character in that set case-folds or normalizes to another (nor does anything
 * outside it fold into it), so the filesystem's comparison and `===` agree.
 */
const LITERAL_CODE_UNIT = /^[a-z0-9-]$/;

/** Introduces a fixed-width escape; never appears in a segment on its own. */
const ESCAPE = "_";

/** Code units per escape, so decoding needs no lookahead beyond a fixed span. */
const ESCAPE_DIGITS = 4;

/**
 * The segment for an empty id. A bare escape is unreachable by the encoder for
 * any non-empty input — every `_` it emits is followed by four hex digits — so
 * this cannot collide with the encoding of a real id.
 */
const EMPTY_ID_SEGMENT = ESCAPE;

/**
 * One path segment's worth of an authored id. Anything outside the safe set —
 * separators, traversal dots, control characters — collapses to `_`, so a
 * segment can only ever name a child of its parent.
 *
 * Replacing unsafe characters is LOSSY, and these segments carry isolation
 * rather than decoration: authored ids are free-form (`z.string().trim()
 * .min(1)`), so "a/b" and "a?b" both reduce to "a_b" and two distinct
 * concurrent contexts land on one scratch and one payload directory — the
 * sharing the per-context envelope exists to prevent.
 *
 * So the mapping is REVERSIBLE rather than merely unlikely to collide: each
 * code unit outside {@link LITERAL_CODE_UNIT} becomes `_` plus its four
 * lowercase hex digits, which {@link fromLanePathSegment} decodes back to the
 * original id. A reversible map is injective by construction, which is the
 * property per-context isolation actually needs. A digest cannot supply it at
 * any width: ids outnumber digests, so some pair must share one — with a
 * truncated digest that pair is merely easier to find.
 *
 * Injectivity as a string map is still not enough, because the thing that has
 * to tell two contexts apart is a filesystem: see {@link LITERAL_CODE_UNIT} for
 * why the image stays inside `[a-z0-9_-]`, where a case-insensitive or
 * normalizing volume compares exactly as `===` does.
 *
 * Encoding is also deterministic, so a context refinds its own scratch on its
 * next turn, and it is the identity on the lowercase kebab-case ids CC authors,
 * so the directory still names the context.
 *
 * The cost is length: a pathological id yields a segment up to five times its
 * size. That surfaces as a failed `mkdir` in the composers, which already
 * treat an undirectable path as a failed turn — a fail-closed outcome rather
 * than the silent truncation that would reintroduce collisions.
 */
export function toLanePathSegment(rawId: string): string {
  if (rawId.length === 0) return EMPTY_ID_SEGMENT;
  let segment = "";
  for (const character of splitCodeUnits(rawId)) {
    segment += LITERAL_CODE_UNIT.test(character)
      ? character
      : `${ESCAPE}${character
          .charCodeAt(0)
          .toString(16)
          .padStart(ESCAPE_DIGITS, "0")}`;
  }
  return segment;
}

/**
 * The inverse of {@link toLanePathSegment}. Exported because it is what makes
 * the injectivity claim checkable: `from(to(id)) === id` for every id is a
 * proof no two ids can share a segment, where sampling distinct outputs is not.
 */
export function fromLanePathSegment(segment: string): string {
  if (segment === EMPTY_ID_SEGMENT) return "";
  let rawId = "";
  let index = 0;
  while (index < segment.length) {
    const character = segment[index];
    if (character !== ESCAPE) {
      rawId += character;
      index += 1;
      continue;
    }
    const hex = segment.slice(index + 1, index + 1 + ESCAPE_DIGITS);
    rawId += String.fromCharCode(Number.parseInt(hex, 16));
    index += 1 + ESCAPE_DIGITS;
  }
  return rawId;
}

/**
 * Iterates UTF-16 CODE UNITS, not code points: `for...of` and spread would
 * combine a surrogate pair into one code point and throw away the distinction
 * between a lone surrogate and a paired one, which is exactly a case two
 * distinct ids must not share.
 */
function* splitCodeUnits(value: string): Generator<string> {
  for (let index = 0; index < value.length; index += 1) {
    yield value.charAt(index);
  }
}

/** Whether `candidate` names something strictly beneath `parent`. */
export function isInsideLanePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/** Whether `candidate` is `parent` itself or something beneath it. */
export function isInsideOrEqualLanePath(
  parent: string,
  candidate: string,
): boolean {
  return parent === candidate || isInsideLanePath(parent, candidate);
}
