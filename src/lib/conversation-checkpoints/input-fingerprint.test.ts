import { describe, expect, it } from "vitest";

import {
  fingerprintAssembledInput,
  fingerprintSubmittedInput,
} from "./input-fingerprint";

const PNG = Buffer.from("png-bytes").toString("base64");

describe("fingerprintSubmittedInput", () => {
  it("is a stable sha256 over the submitted input regardless of object key order", () => {
    const a = fingerprintSubmittedInput({
      promptText: "ship it",
      images: [{ mediaType: "image/png", base64Data: PNG }],
      notepadFeedback: [
        {
          notepadId: "n1",
          notepadName: "Plan",
          notepadRefXml: '<notepad id="n1"/>',
          items: [{ commentId: "c1", location: "L1", quote: "q", body: "c" }],
        },
      ],
    });
    const b = fingerprintSubmittedInput({
      notepadFeedback: [
        {
          items: [{ body: "c", quote: "q", location: "L1", commentId: "c1" }],
          notepadRefXml: '<notepad id="n1"/>',
          notepadName: "Plan",
          notepadId: "n1",
        },
      ],
      images: [{ base64Data: PNG, mediaType: "image/png" }],
      promptText: "ship it",
    });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes when the prompt text, an image, or feedback changes", () => {
    const base = fingerprintSubmittedInput({
      promptText: "ship it",
      images: [],
    });
    expect(
      fingerprintSubmittedInput({ promptText: "ship it!", images: [] }),
    ).not.toBe(base);
    expect(
      fingerprintSubmittedInput({
        promptText: "ship it",
        images: [{ mediaType: "image/png", base64Data: PNG }],
      }),
    ).not.toBe(base);
    expect(
      fingerprintSubmittedInput({
        promptText: "ship it",
        images: [],
        documentFeedback: { items: [] },
      }),
    ).not.toBe(base);
  });

  it("treats absent and undefined feedback the same", () => {
    expect(
      fingerprintSubmittedInput({
        promptText: "x",
        images: [],
        documentFeedback: undefined,
        notepadFeedback: undefined,
      }),
    ).toBe(fingerprintSubmittedInput({ promptText: "x", images: [] }));
  });
});

describe("fingerprintAssembledInput", () => {
  it("covers the exact prompt the provider receives and the image bytes it carries", () => {
    const seeded = fingerprintAssembledInput({
      promptText: "<cc-checkpoint>…</cc-checkpoint>\n\nship it",
      images: [{ mediaType: "image/png", base64Data: PNG }],
    });
    expect(seeded).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      fingerprintAssembledInput({
        promptText: "ship it",
        images: [{ mediaType: "image/png", base64Data: PNG }],
      }),
    ).not.toBe(seeded);
    expect(
      fingerprintAssembledInput({
        promptText: "<cc-checkpoint>…</cc-checkpoint>\n\nship it",
        images: [],
      }),
    ).not.toBe(seeded);
    expect(
      fingerprintAssembledInput({
        promptText: "<cc-checkpoint>…</cc-checkpoint>\n\nship it",
        images: [{ base64Data: PNG, mediaType: "image/png" }],
      }),
    ).toBe(seeded);
  });

  it("never collides with the submitted-input fingerprint of the same text", () => {
    expect(fingerprintAssembledInput({ promptText: "x", images: [] })).not.toBe(
      fingerprintSubmittedInput({ promptText: "x", images: [] }),
    );
  });
});
