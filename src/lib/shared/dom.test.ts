// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isEditableTarget } from "./dom";

describe("isEditableTarget", () => {
  it("returns true for an input element", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
  });

  it("returns true for a textarea element", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
  });

  it("returns true for a select element", () => {
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
  });

  it("returns true for a contentEditable element", () => {
    const el = document.createElement("div");
    // jsdom does not compute isContentEditable from the attribute, so set it.
    Object.defineProperty(el, "isContentEditable", {
      value: true,
      configurable: true,
    });
    expect(isEditableTarget(el)).toBe(true);
  });

  it("returns false for a button", () => {
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
  });

  it("returns false for a plain div", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});
