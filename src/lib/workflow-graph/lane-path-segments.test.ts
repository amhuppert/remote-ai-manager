/**
 * The segment discipline carries ISOLATION, not decoration: two concurrent
 * contexts that derive the same segment share one scratch, tmp, and payload
 * directory, and each can then mutate the other's private files while staying
 * inside its own apparent policy. Injectivity over free-form authored ids is
 * therefore the property under test, adversarial inputs included.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { fromLanePathSegment, toLanePathSegment } from "./lane-path-segments";

/**
 * Built from code units rather than written literally: source-level escapes for
 * these are rewritten by editing tooling long before they reach an assertion,
 * and a raw control byte in a fixture makes the file unreadable to `grep`.
 */
const fromCodeUnits = (...units: number[]): string =>
  String.fromCharCode(...units);

const HIGH_SURROGATE = fromCodeUnits(0xd800);
const NEXT_HIGH_SURROGATE = fromCodeUnits(0xd801);
const LOW_SURROGATE = fromCodeUnits(0xdc00);
const SURROGATE_PAIR = fromCodeUnits(0xd800, 0xdc00);
const NUL = fromCodeUnits(0x00);
const DEL = fromCodeUnits(0x7f);
/** The same grapheme under NFC and NFD — distinct strings, one appearance. */
const PRECOMPOSED_E_ACUTE = fromCodeUnits(0x00e9);
const DECOMPOSED_E_ACUTE = fromCodeUnits(0x0065, 0x0301);

/**
 * Ids chosen to break a sanitize-and-hash scheme: pairs differing only outside
 * the safe charset, pairs differing only in a lone surrogate, traversal names,
 * and the escape character itself.
 */
const ADVERSARIAL_IDS = [
  "a/b",
  "a?b",
  "a_b",
  "a b",
  "..",
  ".",
  "",
  "_",
  "_002f",
  "../../etc/passwd",
  "ctx-1",
  "ctx_1",
  "CTX-1",
  HIGH_SURROGATE,
  NEXT_HIGH_SURROGATE,
  LOW_SURROGATE,
  SURROGATE_PAIR,
  NUL,
  DEL,
  PRECOMPOSED_E_ACUTE,
  DECOMPOSED_E_ACUTE,
];

describe("toLanePathSegment", () => {
  it("distinguishes ids that sanitize to the same legible prefix", () => {
    expect(toLanePathSegment("a/b")).not.toBe(toLanePathSegment("a?b"));
  });

  it("distinguishes lone surrogates that share a UTF-8 encoding", () => {
    // A lone surrogate has no UTF-8 form: any encoding through it replaces
    // every one of these with U+FFFD, collapsing them to a single value. Ids
    // that differ only here are therefore the case a segment mapping is most
    // likely to lose, and losing it means two contexts share a directory.
    expect(toLanePathSegment(HIGH_SURROGATE)).not.toBe(
      toLanePathSegment(NEXT_HIGH_SURROGATE),
    );
    expect(toLanePathSegment(HIGH_SURROGATE)).not.toBe(
      toLanePathSegment(LOW_SURROGATE),
    );
    expect(toLanePathSegment(HIGH_SURROGATE)).not.toBe(
      toLanePathSegment(SURROGATE_PAIR),
    );
  });

  // The load-bearing property, and the reason it is provable rather than
  // sampled: a REVERSIBLE encoding is injective by construction, so no pair of
  // distinct ids can share a segment. A digest — of any width — can only ever
  // make collisions unlikely, and "unlikely" is not what per-context isolation
  // is allowed to rest on.
  it("round-trips every adversarial id, which is what makes it injective", () => {
    for (const id of ADVERSARIAL_IDS) {
      expect(fromLanePathSegment(toLanePathSegment(id))).toBe(id);
    }
  });

  it("leaves an ordinary authored id completely legible", () => {
    // Common ids are already path-safe, so the encoding is the identity on
    // them: the directory a human looks at still names the context.
    expect(toLanePathSegment("context-build")).toBe("context-build");
    expect(toLanePathSegment("spec-task-lwp-task-envelope-composer")).toBe(
      "spec-task-lwp-task-envelope-composer",
    );
  });

  it("never emits a segment that is empty or names traversal", () => {
    for (const id of ADVERSARIAL_IDS) {
      const segment = toLanePathSegment(id);
      expect(segment.length).toBeGreaterThan(0);
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
    }
  });

  it("is injective across adversarial ids", () => {
    // Guards the assertion itself: a duplicated fixture would fail the
    // injectivity check below for a reason that has nothing to do with the code.
    expect(new Set(ADVERSARIAL_IDS).size).toBe(ADVERSARIAL_IDS.length);

    const segments = ADVERSARIAL_IDS.map((id) => toLanePathSegment(id));
    expect(new Set(segments).size).toBe(ADVERSARIAL_IDS.length);
  });

  // Distinct STRINGS are not distinct DIRECTORIES. macOS ships case-insensitive
  // volumes by default — the platform CC runs on — so "ctx-1" and "CTX-1" name
  // one directory there however carefully the encoding kept them apart as
  // strings. Injectivity has to survive the filesystem's own comparison, not
  // just JavaScript's.
  it("distinguishes ids that differ only in case", () => {
    expect(toLanePathSegment("ctx-1").toLowerCase()).not.toBe(
      toLanePathSegment("CTX-1").toLowerCase(),
    );
  });

  it("stays injective under the comparison a case-insensitive filesystem makes", () => {
    const folded = ADVERSARIAL_IDS.map((id) =>
      toLanePathSegment(id).normalize("NFC").toLowerCase(),
    );
    expect(new Set(folded).size).toBe(ADVERSARIAL_IDS.length);
  });

  // The structural reason the property above holds for EVERY id rather than the
  // sampled ones: the image is ASCII lowercase, digits, `-` and `_`. No such
  // character case-folds or normalizes to another, and no character outside the
  // image folds INTO it, so the filesystem's comparison and `===` agree.
  it("emits only characters that are their own case fold and normal form", () => {
    for (const id of ADVERSARIAL_IDS) {
      expect(toLanePathSegment(id)).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("derives the same segment for the same id so a context refinds scratch", () => {
    expect(toLanePathSegment("ctx-1")).toBe(toLanePathSegment("ctx-1"));
  });

  it("can only ever name a child of its parent", () => {
    for (const id of ["../escape", "a/b", "..", "", NUL, HIGH_SURROGATE]) {
      const segment = toLanePathSegment(id);
      expect(segment).not.toContain(path.sep);
      expect(segment).not.toContain("/");
      expect(path.basename(segment)).toBe(segment);
      expect(path.join("/parent", segment)).toBe(`/parent/${segment}`);
    }
  });
});
