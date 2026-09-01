import { describe, expect, it } from "vitest";

import { composeAppendedNotepadContent } from "@/lib/notepads/append-composition";

import {
  captureConfirmationPreview,
  contentWithoutAppended,
  transcriptionContextFrom,
} from "./capture-confirmation";

describe("captureConfirmationPreview (R25.1)", () => {
  it("quotes the first line of the transcription", () => {
    expect(
      captureConfirmationPreview("Ship the pill first.\nThen the retry path."),
    ).toBe("Ship the pill first.");
  });

  it("bounds a long first line", () => {
    const preview = captureConfirmationPreview("word ".repeat(40));

    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(61);
  });

  it("is empty for empty speech", () => {
    expect(captureConfirmationPreview("   \n  ")).toBe("");
  });
});

describe("contentWithoutAppended (R25.1 undo)", () => {
  it("inverts the append composition on a notepad that had content", () => {
    const before = "Existing content.";
    const payload = "a captured thought";

    expect(
      contentWithoutAppended(
        composeAppendedNotepadContent(before, payload),
        payload,
      ),
    ).toBe(before);
  });

  it("inverts the append composition on an empty notepad", () => {
    const payload = "a captured thought";

    expect(
      contentWithoutAppended(
        composeAppendedNotepadContent("", payload),
        payload,
      ),
    ).toBe("");
  });

  it("declines when the capture is no longer the tail", () => {
    const payload = "a captured thought";
    const grown = `${composeAppendedNotepadContent("Existing.", payload)}\n\nSomeone else wrote.`;

    expect(contentWithoutAppended(grown, payload)).toBeNull();
  });
});

describe("transcriptionContextFrom (R25.2)", () => {
  it("sends an empty destination no context at all", () => {
    expect(transcriptionContextFrom("")).toBe("");
    expect(transcriptionContextFrom("   \n ")).toBe("");
  });

  it("sends short content whole", () => {
    expect(transcriptionContextFrom("Existing notepad content.")).toBe(
      "Existing notepad content.",
    );
  });

  it("bounds long content to its tail — the words nearest the new speech", () => {
    const content = `${"x".repeat(9000)}the recent part`;

    const context = transcriptionContextFrom(content);

    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context.endsWith("the recent part")).toBe(true);
  });
});
