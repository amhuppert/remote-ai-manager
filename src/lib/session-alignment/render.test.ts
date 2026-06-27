import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ALIGNMENT_DOCUMENT_PATH,
  ALIGNMENT_INLINE_THRESHOLD,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  SCAFFOLD_TEMPLATE,
} from "./render";

const SCAFFOLD_SECTIONS = [
  "Mission",
  "Decisions",
  "Constraints",
  "Non-goals",
  "Known ambiguities",
  "Relevant sources",
];

function makeContent(length: number): string {
  // Distinctive, deterministic body so we can assert verbatim inlining and the
  // absence of full inlining in the digest path.
  const marker = "SENTINEL_BODY_LINE ";
  let body = "";
  while (body.length < length) {
    body += marker;
  }
  return body.slice(0, length);
}

describe("renderAlignmentPromptSection", () => {
  it("inlines the full content verbatim for a short charter", () => {
    const content = "# Mission\nShip the alignment feature end to end.";
    const section = renderAlignmentPromptSection({
      content,
      filePath: ".cc/session-alignment/charter.md",
    });

    expect(section).toContain(content);
  });

  it("includes the governing preamble in the inline path", () => {
    const section = renderAlignmentPromptSection({
      content: "# Mission\nShort charter.",
      filePath: ".cc/session-alignment/charter.md",
    });

    expect(section.toLowerCase()).toContain("governs the session");
    expect(section.toLowerCase()).toContain("conflicts resolve");
    expect(section.toLowerCase()).toContain("hierarchy");
    expect(section.toLowerCase()).toContain("active decisions");
  });

  it("emits a digest plus a read-the-full-file pointer for a long charter", () => {
    const content = makeContent(ALIGNMENT_INLINE_THRESHOLD + 500);
    const filePath = ".cc/session-alignment/charter.md";
    const section = renderAlignmentPromptSection({ content, filePath });

    // Does NOT inline the whole body.
    expect(section).not.toContain(content);
    expect(section.length).toBeLessThan(content.length);
    // Contains an explicit pointer to the full file at its path.
    expect(section).toContain(filePath);
    expect(section.toLowerCase()).toContain("read the full");
  });

  it("includes the governing preamble in the digest path", () => {
    const content = makeContent(ALIGNMENT_INLINE_THRESHOLD + 500);
    const section = renderAlignmentPromptSection({
      content,
      filePath: ".cc/session-alignment/charter.md",
    });

    expect(section.toLowerCase()).toContain("governs the session");
    expect(section.toLowerCase()).toContain("conflicts resolve");
    expect(section.toLowerCase()).toContain("active decisions");
  });

  it("inlines at the threshold boundary and digests just over it", () => {
    const filePath = ".cc/session-alignment/charter.md";

    const atThreshold = makeContent(ALIGNMENT_INLINE_THRESHOLD);
    const atSection = renderAlignmentPromptSection({
      content: atThreshold,
      filePath,
    });
    expect(atSection).toContain(atThreshold);

    const overThreshold = makeContent(ALIGNMENT_INLINE_THRESHOLD + 1);
    const overSection = renderAlignmentPromptSection({
      content: overThreshold,
      filePath,
    });
    expect(overSection).not.toContain(overThreshold);
    expect(overSection).toContain(filePath);
  });

  it("defaults the pointer path to the canonical mirror location", () => {
    const content = makeContent(ALIGNMENT_INLINE_THRESHOLD + 500);
    const section = renderAlignmentPromptSection({ content });

    expect(section).toContain(ALIGNMENT_DOCUMENT_PATH);
  });
});

describe("computeAlignmentHash", () => {
  it("is stable across trailing-whitespace differences", () => {
    const a = "# Mission\nDo the thing.";
    const b = "# Mission   \nDo the thing.   ";

    expect(computeAlignmentHash(a)).toBe(computeAlignmentHash(b));
  });

  it("is stable across CRLF vs LF line endings", () => {
    const lf = "line one\nline two\nline three";
    const crlf = "line one\r\nline two\r\nline three";

    expect(computeAlignmentHash(lf)).toBe(computeAlignmentHash(crlf));
  });

  it("is stable across collapsed blank lines and leading/trailing blank lines", () => {
    const tight = "para one\n\npara two";
    const loose = "\n\npara one\n\n\n\npara two\n\n";

    expect(computeAlignmentHash(tight)).toBe(computeAlignmentHash(loose));
  });

  it("yields identical hashes for identical content", () => {
    const content = "# Mission\nShared understanding for the session.";

    expect(computeAlignmentHash(content)).toBe(computeAlignmentHash(content));
  });

  it("yields different hashes for genuinely different content", () => {
    expect(computeAlignmentHash("decision: use sqlite")).not.toBe(
      computeAlignmentHash("decision: use postgres"),
    );
  });

  it("returns a sha256 hex digest of the normalized content", () => {
    const content = "# Mission\nDeterministic hash.";
    const expected = createHash("sha256").update(content).digest("hex");

    expect(computeAlignmentHash(content)).toBe(expected);
    expect(computeAlignmentHash(content)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SCAFFOLD_TEMPLATE", () => {
  it("contains all six soft-scaffold sections", () => {
    for (const section of SCAFFOLD_SECTIONS) {
      expect(SCAFFOLD_TEMPLATE).toContain(section);
    }
  });

  it("is free-text markdown headings (not a required schema)", () => {
    for (const section of SCAFFOLD_SECTIONS) {
      expect(SCAFFOLD_TEMPLATE).toContain(`## ${section}`);
    }
  });
});
