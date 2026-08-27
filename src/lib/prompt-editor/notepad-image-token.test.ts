import { describe, expect, it } from "vitest";
import {
  buildNotepadImageToken,
  findNotepadImageTokens,
} from "./notepad-image-token";

describe("notepad image tokens", () => {
  it("builds the canonical id-addressed token", () => {
    expect(buildNotepadImageToken("img-7a2f")).toBe("[Image: img-7a2f]");
  });

  it("finds tokens with their offsets in document order", () => {
    const text = "before [Image: a1] middle [Image: b2] after";
    expect(findNotepadImageTokens(text)).toEqual([
      { imageId: "a1", start: 7, end: 18, raw: "[Image: a1]" },
      { imageId: "b2", start: 26, end: 37, raw: "[Image: b2]" },
    ]);
  });

  it("round-trips its own built form", () => {
    const token = buildNotepadImageToken(
      "0d4b2c8e-1f66-4a2b-9c3d-5e7f8a9b0c1d",
    );
    expect(findNotepadImageTokens(token)).toEqual([
      {
        imageId: "0d4b2c8e-1f66-4a2b-9c3d-5e7f8a9b0c1d",
        start: 0,
        end: token.length,
        raw: token,
      },
    ]);
  });

  it("ignores positional prompt markers and malformed tokens", () => {
    expect(
      findNotepadImageTokens("[Image #3] [Image: ] [Image:x] [Image: a b]"),
    ).toEqual([]);
  });
});
