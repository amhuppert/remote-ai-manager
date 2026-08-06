import { describe, expect, it } from "vitest";
import {
  escapeDiagnosticValue,
  flattenDiagnosticText,
} from "./diagnostic-text";

/**
 * Everything a reader downstream of a diagnostic may treat as a line break.
 * Built from code points rather than written literally: a control character in
 * a source file makes it read as binary to plain text tooling.
 */
const LINE_TERMINATORS = [
  { label: "line feed", char: "\n" },
  { label: "carriage return", char: "\r" },
  { label: "line separator", char: String.fromCharCode(0x2028) },
  { label: "paragraph separator", char: String.fromCharCode(0x2029) },
];

describe("escapeDiagnosticValue", () => {
  it("leaves a well-formed value byte-identical", () => {
    expect(escapeDiagnosticValue("security-reviewer")).toBe(
      "security-reviewer",
    );
    expect(escapeDiagnosticValue("builtin:general-reviewer")).toBe(
      "builtin:general-reviewer",
    );
  });

  it("escapes the quote and backslash so a value cannot fake its own span", () => {
    expect(escapeDiagnosticValue('ev"il')).toBe('ev\\"il');
    expect(escapeDiagnosticValue("a\\b")).toBe("a\\\\b");
  });

  it.each(LINE_TERMINATORS)(
    "escapes a $label so the value cannot break the line",
    ({ char }) => {
      const escaped = escapeDiagnosticValue(`a${char}b`);

      expect(escaped).not.toContain(char);
      expect(escaped.split("\n")).toHaveLength(1);
    },
  );

  it("escapes a control character with no shorthand to its uXXXX form", () => {
    expect(escapeDiagnosticValue(`a${String.fromCharCode(0x07)}b`)).toBe(
      "a\\u0007b",
    );
    expect(escapeDiagnosticValue(`a${String.fromCharCode(0x7f)}b`)).toBe(
      "a\\u007fb",
    );
  });
});

describe("flattenDiagnosticText", () => {
  it("leaves an ordinary message byte-identical, quotes and all", () => {
    const message = 'Duplicate validator assignment id "security" - be unique.';

    expect(flattenDiagnosticText(message)).toBe(message);
  });

  it.each(LINE_TERMINATORS)(
    "collapses a $label so one diagnostic stays one line",
    ({ char }) => {
      const flattened = flattenDiagnosticText(`bad id${char}  name: forged`);

      // Escaped, not stripped: the reader still sees what the document said.
      expect(flattened.split("\n")).toHaveLength(1);
      expect(flattened).toContain("forged");
    },
  );

  it("is idempotent: flattening already-flat text changes nothing", () => {
    const once = flattenDiagnosticText("a\nb\tc");

    expect(flattenDiagnosticText(once)).toBe(once);
  });
});
