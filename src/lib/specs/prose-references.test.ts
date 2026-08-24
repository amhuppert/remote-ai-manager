import { describe, expect, it } from "vitest";

import { extractProseHandleReferences } from "./prose-references";

/**
 * The false-positive boundary of the prose scanner is defined here, not by the
 * regexes: this matrix is the contract every lint finding over Markdown prose
 * rests on. A token flagged here blocks propose, so each "must not flag" case
 * is as load-bearing as each "must flag" one.
 */

const SLUG = "native-sdd";

const tokens = (text: string, contextSlug: string = SLUG): string[] =>
  extractProseHandleReferences(text, contextSlug).map(
    (reference) => reference.token,
  );

describe("prose handle extraction — standalone tokens", () => {
  it("flags every handle form as a standalone token", () => {
    expect(tokens("R3 R1.2 D4 T2 Q1 A4")).toEqual([
      "R3",
      "R1.2",
      "D4",
      "T2",
      "Q1",
      "A4",
    ]);
  });

  it("flags a token in sentence-final position", () => {
    expect(tokens("The importer already covers this per R3.")).toEqual(["R3"]);
    expect(tokens("Traced to R1.2.")).toEqual(["R1.2"]);
  });

  it("flags a parenthesized token", () => {
    expect(tokens("The chosen approach (see D4) stands.")).toEqual(["D4"]);
  });

  it("flags tokens separated by commas in a list", () => {
    expect(tokens("Covers R1.2, T2, and A4 together.")).toEqual([
      "R1.2",
      "T2",
      "A4",
    ]);
  });

  it("flags a token at the very start and end of the field", () => {
    expect(tokens("R3 opens the field")).toEqual(["R3"]);
    expect(tokens("the field closes on T2")).toEqual(["T2"]);
  });

  it("resolves criterion before requirement, matching the canonical grammar", () => {
    expect(extractProseHandleReferences("R12.2 and R12", SLUG)).toEqual([
      {
        token: "R12.2",
        handle: {
          slug: SLUG,
          kind: "criterion",
          requirementNumber: 12,
          criterionNumber: 2,
        },
      },
      {
        token: "R12",
        handle: { slug: SLUG, kind: "requirement", requirementNumber: 12 },
      },
    ]);
  });

  it("resolves each numbered kind to its parsed handle", () => {
    expect(
      extractProseHandleReferences("D4 T2 Q1 A4", SLUG).map(
        ({ handle }) => handle,
      ),
    ).toEqual([
      { slug: SLUG, kind: "decision", number: 4 },
      { slug: SLUG, kind: "task", number: 2 },
      { slug: SLUG, kind: "question", number: 1 },
      { slug: SLUG, kind: "assumption", number: 4 },
    ]);
  });

  it("reports every occurrence, leaving deduplication to the caller", () => {
    expect(tokens("R3 restates R3 for emphasis")).toEqual(["R3", "R3"]);
  });
});

describe("prose handle extraction — slug qualification", () => {
  it("flags a token qualified with the spec's own slug", () => {
    expect(
      extractProseHandleReferences(`See ${SLUG}/R1 for details.`, SLUG),
    ).toEqual([
      {
        token: `${SLUG}/R1`,
        handle: { slug: SLUG, kind: "requirement", requirementNumber: 1 },
      },
    ]);
  });

  it("flags a same-slug qualified criterion, decision, and task", () => {
    expect(
      tokens(`${SLUG}/R1.2, ${SLUG}/D3, and ${SLUG}/T4 are covered.`),
    ).toEqual([`${SLUG}/R1.2`, `${SLUG}/D3`, `${SLUG}/T4`]);
  });

  it("flags same-slug qualified question and assumption forms", () => {
    expect(
      extractProseHandleReferences(
        `Settled by ${SLUG}/Q1 and resting on ${SLUG}/A4.`,
        SLUG,
      ),
    ).toEqual([
      {
        token: `${SLUG}/Q1`,
        handle: { slug: SLUG, kind: "question", number: 1 },
      },
      {
        token: `${SLUG}/A4`,
        handle: { slug: SLUG, kind: "assumption", number: 4 },
      },
    ]);
  });

  it("recognizes a foreign-slug question or assumption and skips it", () => {
    expect(tokens("other-spec/Q1 and other-spec/A4 are elsewhere.")).toEqual(
      [],
    );
  });

  it("recognizes a foreign-slug token and skips it", () => {
    expect(tokens("other-spec/R1 belongs to another spec.")).toEqual([]);
    expect(tokens("workflow-graph/T7 is out of scope.")).toEqual([]);
  });
});

describe("prose handle extraction — masked regions", () => {
  it("masks a fenced code block introduced by backticks", () => {
    expect(tokens("before\n```\nR3\n```\nafter")).toEqual([]);
  });

  it("masks a fenced block carrying an info string", () => {
    expect(tokens("```ts\nconst handle = R3;\n```")).toEqual([]);
  });

  it("masks a tilde-fenced block", () => {
    expect(tokens("~~~\nR3\n~~~")).toEqual([]);
  });

  it("masks a fence indented up to three spaces", () => {
    expect(tokens("   ```\n   R3\n   ```")).toEqual([]);
  });

  it("keeps scanning prose outside the fence", () => {
    expect(tokens("R1 before\n```\nR2\n```\nR3 after")).toEqual(["R1", "R3"]);
  });

  it("masks to the end of the field when a fence is never closed", () => {
    expect(tokens("R1 before\n```\nR2 and R3 forever")).toEqual(["R1"]);
  });

  it("does not treat a longer fence as closing a shorter one prematurely", () => {
    expect(tokens("````\nR2\n```\nR3\n````\nR4")).toEqual(["R4"]);
  });

  it("masks an inline code span", () => {
    expect(tokens("Write `R3` to mention it literally.")).toEqual([]);
  });

  it("masks a multi-backtick code span containing a backtick", () => {
    expect(tokens("The token ``R3 and ` inside`` is literal.")).toEqual([]);
  });

  it("leaves an unclosed backtick run unmasked", () => {
    expect(tokens("R3 ` is a stray tick")).toEqual(["R3"]);
  });

  it("masks an autolink", () => {
    expect(tokens("See <https://example.dev/specs#R3> for context.")).toEqual(
      [],
    );
  });

  it("masks a raw GFM email autolink", () => {
    expect(tokens("Contact R9@example.com for context.")).toEqual([]);
    expect(tokens("Contact R9@example.com.")).toEqual([]);
    expect(tokens("Use mailto:R9@example.com.")).toEqual([]);
  });

  it("masks a raw URL", () => {
    expect(tokens("See https://example.dev/specs#R3 for context.")).toEqual([]);
    expect(tokens("See www.example.dev/specs#R3 for context.")).toEqual([]);
  });

  it("masks a link destination while still scanning the link text", () => {
    expect(tokens("[the R3 note](https://example.dev/specs#R4)")).toEqual([
      "R3",
    ]);
    expect(tokens("[the R3 note](<https://example.dev/specs#R4>)")).toEqual([
      "R3",
    ]);
  });

  it("masks a link reference definition", () => {
    expect(
      tokens("[note]: https://example.dev/specs#R3 'The R4 note'"),
    ).toEqual([]);
  });

  /**
   * Destination masking is exercised with RELATIVE destinations on purpose. An
   * absolute URL is masked by the raw-URL pass as well, so a matrix built only
   * from `https://…` destinations passes even when destination masking is
   * broken outright — it never tests this mask independently.
   */
  it("masks a relative link destination", () => {
    expect(tokens("[the note](docs/R9.md) explains it.")).toEqual([]);
    expect(tokens("[the R3 note](docs/R9.md)")).toEqual(["R3"]);
  });

  it("leaves destinations after escaped link delimiters scannable", () => {
    expect(tokens("See \\[literal\\](R9) for context.")).toEqual(["R9"]);
    expect(tokens("See [literal\\](R9) for context.")).toEqual(["R9"]);
  });

  it("leaves balanced text that is not a link destination scannable", () => {
    expect(tokens("A stray closing bracket](R9) remains prose.")).toEqual([
      "R9",
    ]);
    expect(tokens('[details](R9 "unterminated title)')).toEqual(["R9"]);
    expect(tokens('[details](R9 "title" junk)')).toEqual(["R9"]);
    expect(tokens('[details](R9 "unterminated) later " junk)')).toEqual(["R9"]);
    expect(tokens("[details](R9 trailing)")).toEqual(["R9"]);
    expect(tokens("[details](R9\n trailing)")).toEqual(["R9"]);
    expect(tokens("[details](\\# R9)")).toEqual(["R9"]);
    expect(tokens("[details]((nested) R9)")).toEqual(["R9"]);
  });

  /**
   * A bare link destination may carry balanced parentheses, so the destination
   * is scanned by depth rather than matched by a regex, which cannot balance.
   * `[details](docs/(R9))` is valid Markdown and asserts no reference.
   */
  it("masks a destination containing balanced parentheses", () => {
    expect(tokens("[details](docs/(R9))")).toEqual([]);
    expect(tokens("[details](a/(b/(R9)))")).toEqual([]);
    expect(tokens("[details](<docs/(R9)>)")).toEqual([]);
  });

  /**
   * A pointy-bracketed destination is delimited by `>`, and its parentheses do
   * NOT have to balance — `[details](<docs/(R9>)` is valid Markdown whose
   * destination is `docs/(R9`. Counting depth through the brackets never
   * reaches the closing paren, so the destination stays scannable and a link
   * becomes a false blocking finding.
   */
  it("masks a pointy destination whose parentheses do not balance", () => {
    expect(tokens("[details](<docs/(R9>)")).toEqual([]);
    expect(tokens("[details](<docs/)R9>)")).toEqual([]);
    expect(tokens("[a](<x/(R9>) then [b](<y/(A4>)")).toEqual([]);
  });

  it("masks a pointy destination containing an escaped bracket", () => {
    expect(tokens("[details](<docs/\\>R9>)")).toEqual([]);
  });

  /**
   * A pointy destination may not contain a line ending, so this is not a link
   * at all and the token is correctly left scannable.
   */
  it("leaves a pointy destination broken by a newline scannable", () => {
    expect(tokens("[details](<docs/\nR9>)")).toEqual(["R9"]);
  });

  /**
   * Markdown places no length limit on a destination or a title, so neither may
   * a mask: a bounded scan silently stops masking valid content and turns long
   * but ordinary links into false blocking findings.
   */
  it("masks a destination and a title of arbitrary length", () => {
    const filler = "a".repeat(4_000);
    expect(tokens(`[details](docs/${filler}/R9.md)`)).toEqual([]);
    expect(tokens(`[details](docs/x "${filler} R9")`)).toEqual([]);
    expect(tokens(`[details](<docs/${filler}/R9.md>)`)).toEqual([]);
  });

  /**
   * Only failed scans are charged against the whole-field budget, so ordinary
   * content carrying a few stray `](` runs must still mask every real link
   * after them. A budget cheap enough to exhaust here would reintroduce exactly
   * the false findings this mask exists to prevent.
   */
  it("still masks a valid link after earlier runs that never close", () => {
    const strays = "see ]( and ]( and ]( elsewhere\n".repeat(20);

    expect(tokens(`${strays}[details](docs/R9.md)`)).toEqual([]);
    expect(tokens(`${strays}[details](<docs/(R9>)`)).toEqual([]);
  });

  /**
   * A title is separated from the destination by whitespace, so a quote WITHOUT
   * that separation is an ordinary character of the destination.
   * `[details](docs/it's(R9))` is a valid bare destination with balanced
   * parentheses; treating its apostrophe as a title opener abandons the
   * destination and turns the link into a false blocking finding.
   */
  it("masks a bare destination containing an apostrophe or quote", () => {
    expect(tokens("[details](docs/it's(R9))")).toEqual([]);
    expect(tokens('[details](docs/say"hi"(R9))')).toEqual([]);
    expect(tokens("[details](docs/it's/R9.md)")).toEqual([]);
  });

  it("masks a destination whose title carries parentheses", () => {
    expect(tokens(`[details](docs/x "see (R9)")`)).toEqual([]);
    expect(tokens(`[details](docs/x 'see R9 for this')`)).toEqual([]);
  });

  it("masks a destination containing an escaped parenthesis", () => {
    expect(tokens("[details](docs/x\\)R9)")).toEqual([]);
  });

  /**
   * An unbalanced run is not a link destination at all, so it is left
   * scannable rather than masked to end of field — the conservative direction
   * for a mask whose job is to avoid asserting a reference, not to hide one.
   */
  it("leaves an unbalanced destination scannable", () => {
    expect(tokens("[details](docs/(R9)")).toEqual(["R9"]);
  });

  /**
   * Deliberate boundary, not an oversight: recognizing indented code requires
   * block context (list continuation lines are indented too), which is exactly
   * the parser this scanner refuses to become. Spec prose uses fenced code, and
   * the fence and inline-code masks are the documented way to mention a literal
   * token without asserting a reference.
   */
  it("does not mask four-space indented code", () => {
    expect(tokens("prose\n\n    const handle = R3;\n")).toEqual(["R3"]);
  });
});

describe("prose handle extraction — excluded shapes", () => {
  it("does not flag a token embedded in a larger word or identifier", () => {
    expect(tokens("PR1 R10x T3sting FOO-R3 xQ1 A4b")).toEqual([]);
  });

  it("does not flag a handle-shaped path fragment", () => {
    expect(tokens("us-east-1/R2 names a region, not a criterion.")).toEqual([]);
    expect(tokens("docs/designs/R3 is a path.")).toEqual([]);
  });

  it("does not flag version-ish strings", () => {
    expect(tokens("v1.2 shipped.")).toEqual([]);
    // No partial match: the R1.2 prefix of R1.2.3 must not become a reference.
    expect(tokens("R1.2.3 shipped.")).toEqual([]);
    expect(tokens("Released as R1.2.3 last week.")).toEqual([]);
  });

  it("does not flag zero or leading-zero forms the grammar rejects", () => {
    expect(tokens("R0 R01 D0 T00 Q0 A007")).toEqual([]);
  });

  /**
   * Masks position themselves by regex index, which counts UTF-16 code units;
   * an astral character ahead of a masked region would slide the mask off it.
   */
  it("keeps masks aligned after an astral character", () => {
    expect(tokens("🚀 see `R3` and https://example.dev/R4 — done")).toEqual([]);
    expect(tokens("🚀 R3 stands")).toEqual(["R3"]);
  });

  it("does not flag a lowercase look-alike", () => {
    expect(tokens("r3 and d4 are not handles.")).toEqual([]);
  });

  it("returns nothing when the context slug is not a canonical slug", () => {
    expect(tokens("R3 is unresolvable here.", "Not A Slug")).toEqual([]);
  });
});

describe("prose handle extraction — scanning cost", () => {
  /**
   * Lint runs on every propose, import, and status read, so a mask that
   * backtracks quadratically is a denial of service on ordinary content, not a
   * micro-optimization: an unbounded scheme run in the URL mask took ~3.4
   * billion steps on this exact input and blew a 15s CLI read budget. The
   * bound is deliberately loose — it separates linear from quadratic, and
   * nothing finer would survive a loaded machine.
   */
  it("scans a large field without quadratic backtracking", () => {
    const body = "x".repeat(80 * 1024);

    const startedAt = performance.now();
    const references = extractProseHandleReferences(body, SLUG);
    const elapsed = performance.now() - startedAt;

    expect(references).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
  });

  /**
   * The destination scanner walks forward from every `](`, so a field full of
   * runs that never close would re-scan to the end once per run. That is the
   * same quadratic shape the scheme bound above exists to prevent, reachable
   * from content a person could plausibly paste.
   */
  it("scans many unclosed link destinations without quadratic backtracking", () => {
    const body = "](".repeat(40_000);

    const startedAt = performance.now();
    const references = extractProseHandleReferences(body, SLUG);
    const elapsed = performance.now() - startedAt;

    expect(references).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
  });

  /**
   * The cost guard may not buy speed with correctness: a valid link still has
   * to be masked no matter how much unclosed noise precedes it. Bailing out
   * part-way through a field silently exposes every destination after the bail,
   * which is the very false finding this mask exists to prevent.
   */
  it("masks a valid destination however much unclosed noise precedes it", () => {
    const body = `${"](".repeat(40_000)}[details](R9)`;

    const startedAt = performance.now();
    const references = extractProseHandleReferences(body, SLUG);
    const elapsed = performance.now() - startedAt;

    expect(references).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("still finds a token in a large field", () => {
    const body = `${"word ".repeat(20_000)}R9 ${"tail ".repeat(20_000)}`;

    expect(tokens(body)).toEqual(["R9"]);
  });
});
