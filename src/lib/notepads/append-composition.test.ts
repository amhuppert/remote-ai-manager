import { describe, expect, it } from "vitest";

import {
  composeAppendedNotepadContent,
  trimAppendedNotepadContent,
} from "./append-composition";

const PAYLOAD = "> clipped line\n— <message-ref />";

describe("trimAppendedNotepadContent", () => {
  it("removes the payload and its single separator from the content tail", () => {
    const composed = composeAppendedNotepadContent("existing notes", PAYLOAD);
    expect(trimAppendedNotepadContent(composed, PAYLOAD)).toBe(
      "existing notes",
    );
  });

  it("returns empty content when the payload was the first append", () => {
    const composed = composeAppendedNotepadContent("", PAYLOAD);
    expect(trimAppendedNotepadContent(composed, PAYLOAD)).toBe("");
  });

  it("round-trips whatever compose produced", () => {
    for (const current of ["", "a", "a\n\nb", "trailing\n"]) {
      const composed = composeAppendedNotepadContent(current, PAYLOAD);
      expect(trimAppendedNotepadContent(composed, PAYLOAD)).toBe(current);
    }
  });

  it("refuses when the content no longer ends with the payload", () => {
    const composed = composeAppendedNotepadContent("existing", PAYLOAD);
    expect(trimAppendedNotepadContent(`${composed} and more`, PAYLOAD)).toBe(
      null,
    );
  });

  it("refuses when the payload appears mid-content only", () => {
    const grown = `${composeAppendedNotepadContent("notes", PAYLOAD)}\n\nlater thoughts`;
    expect(trimAppendedNotepadContent(grown, PAYLOAD)).toBe(null);
  });

  it("refuses when the tail matches the payload without the separator", () => {
    // A payload merged into the last line (no blank-line separator) is not the
    // composition's work, so undo must not carve it out.
    expect(trimAppendedNotepadContent(`prefix ${PAYLOAD}`, PAYLOAD)).toBe(null);
  });
});
