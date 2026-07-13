import { describe, expect, it } from "vitest";
import {
  applyTextareaShortcut,
  findNextWordEnd,
  findPreviousWordStart,
  getMultilineShortcut,
  insertTextAtActiveEdge,
  type TextSelection,
} from "./shortcuts";

const collapsed = (position: number): TextSelection => ({
  start: position,
  end: position,
});

describe("getMultilineShortcut", () => {
  it("maps the shared readline chords and platform submit chord", () => {
    expect(getMultilineShortcut({ key: "a", ctrlKey: true }, false)).toBe(
      "line-start",
    );
    expect(getMultilineShortcut({ key: "E", ctrlKey: true }, false)).toBe(
      "line-end",
    );
    expect(getMultilineShortcut({ key: "u", ctrlKey: true }, false)).toBe(
      "delete-line-start",
    );
    expect(getMultilineShortcut({ key: "k", ctrlKey: true }, false)).toBe(
      "delete-line-end",
    );
    expect(getMultilineShortcut({ key: "w", ctrlKey: true }, false)).toBe(
      "delete-word-backward",
    );
    expect(getMultilineShortcut({ key: "b", altKey: true }, false)).toBe(
      "word-backward",
    );
    expect(getMultilineShortcut({ key: "f", altKey: true }, false)).toBe(
      "word-forward",
    );
    expect(getMultilineShortcut({ key: "d", altKey: true }, false)).toBe(
      "delete-word-forward",
    );
    expect(getMultilineShortcut({ key: "Enter", ctrlKey: true }, false)).toBe(
      "submit",
    );
    expect(getMultilineShortcut({ key: "Enter", metaKey: true }, true)).toBe(
      "submit",
    );
  });

  it("leaves plain Enter and composition events to the editor", () => {
    expect(getMultilineShortcut({ key: "Enter" }, false)).toBeNull();
    expect(
      getMultilineShortcut(
        { key: "Enter", ctrlKey: true, isComposing: true },
        false,
      ),
    ).toBeNull();
  });

  it("requires the exact platform submit modifier", () => {
    expect(
      getMultilineShortcut(
        { key: "Enter", ctrlKey: true, metaKey: true },
        false,
      ),
    ).toBeNull();
    expect(
      getMultilineShortcut(
        { key: "Enter", ctrlKey: true, shiftKey: true },
        false,
      ),
    ).toBeNull();
    expect(
      getMultilineShortcut(
        { key: "Enter", metaKey: true, shiftKey: true },
        true,
      ),
    ).toBeNull();
    expect(
      getMultilineShortcut(
        { key: "Enter", ctrlKey: true, metaKey: true },
        true,
      ),
    ).toBeNull();
  });
});

describe("textarea shortcut application", () => {
  const value = "alpha beta\ngamma delta";

  it("moves within the current logical line", () => {
    expect(applyTextareaShortcut(value, collapsed(8), "line-start")).toEqual({
      value,
      selection: collapsed(0),
    });
    expect(applyTextareaShortcut(value, collapsed(8), "line-end")).toEqual({
      value,
      selection: collapsed(10),
    });
  });

  it("deletes to logical line bounds", () => {
    expect(
      applyTextareaShortcut(value, collapsed(8), "delete-line-start"),
    ).toEqual({ value: "ta\ngamma delta", selection: collapsed(0) });
    expect(
      applyTextareaShortcut(value, collapsed(16), "delete-line-end"),
    ).toEqual({ value: "alpha beta\ngamma", selection: collapsed(16) });
  });

  it("uses whitespace-only word boundaries for movement and deletion", () => {
    expect(findPreviousWordStart("run(foo) bar", 8)).toBe(0);
    expect(findNextWordEnd("run(foo) bar", 0)).toBe(8);
    expect(
      applyTextareaShortcut(value, collapsed(10), "word-backward"),
    ).toEqual({
      value,
      selection: collapsed(6),
    });
    expect(applyTextareaShortcut(value, collapsed(11), "word-forward")).toEqual(
      {
        value,
        selection: collapsed(16),
      },
    );
    expect(
      applyTextareaShortcut(value, collapsed(10), "delete-word-backward"),
    ).toEqual({ value: "alpha \ngamma delta", selection: collapsed(6) });
    expect(
      applyTextareaShortcut(value, collapsed(11), "delete-word-forward"),
    ).toEqual({ value: "alpha beta\n delta", selection: collapsed(11) });
  });

  it("keeps edits inside an empty first or trailing logical line", () => {
    const leadingBlank = "\nalpha";
    expect(
      applyTextareaShortcut(leadingBlank, collapsed(0), "delete-line-start"),
    ).toEqual({ value: leadingBlank, selection: collapsed(0) });
    expect(
      applyTextareaShortcut(leadingBlank, collapsed(0), "delete-word-backward"),
    ).toEqual({ value: leadingBlank, selection: collapsed(0) });
    expect(
      applyTextareaShortcut(leadingBlank, collapsed(0), "delete-word-forward"),
    ).toEqual({ value: leadingBlank, selection: collapsed(0) });

    const trailingBlank = "alpha\n";
    expect(
      applyTextareaShortcut(
        trailingBlank,
        collapsed(trailingBlank.length),
        "delete-word-forward",
      ),
    ).toEqual({
      value: trailingBlank,
      selection: collapsed(trailingBlank.length),
    });
  });

  it("uses the active edge of a backward selection", () => {
    expect(
      applyTextareaShortcut(
        value,
        { start: 3, end: 15 },
        "line-start",
        "backward",
      ),
    ).toEqual({ value, selection: collapsed(0) });
    expect(
      applyTextareaShortcut(
        value,
        { start: 3, end: 15 },
        "line-start",
        "forward",
      ),
    ).toEqual({ value, selection: collapsed(11) });
  });
});

describe("voice insertion", () => {
  it("inserts at the active edge without replacing the selected text", () => {
    expect(
      insertTextAtActiveEdge(
        "alpha beta",
        { start: 0, end: 5 },
        "forward",
        " dictated",
      ),
    ).toEqual({
      value: "alpha dictated beta",
      selection: { start: 14, end: 14 },
    });
    expect(
      insertTextAtActiveEdge(
        "alpha beta",
        { start: 0, end: 5 },
        "backward",
        "dictated ",
      ),
    ).toEqual({
      value: "dictated alpha beta",
      selection: { start: 9, end: 9 },
    });
  });
});
