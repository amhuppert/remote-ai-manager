import { describe, it, expect } from "vitest";
import {
  deriveLifecycle,
  isListedInActiveSource,
  countOpen,
} from "./lifecycle";

describe("deriveLifecycle", () => {
  it("returns open when open and not archived", () => {
    expect(deriveLifecycle({ open: true, archived: false })).toBe("open");
  });

  it("returns closed when not open and not archived", () => {
    expect(deriveLifecycle({ open: false, archived: false })).toBe("closed");
  });

  it("returns archived whenever archived, regardless of open", () => {
    expect(deriveLifecycle({ open: false, archived: true })).toBe("archived");
    expect(deriveLifecycle({ open: true, archived: true })).toBe("archived");
  });
});

describe("isListedInActiveSource", () => {
  it("lists non-archived conversations", () => {
    expect(isListedInActiveSource({ archived: false })).toBe(true);
  });
  it("excludes archived conversations", () => {
    expect(isListedInActiveSource({ archived: true })).toBe(false);
  });
});

describe("countOpen", () => {
  it("counts only open && !archived across a mixed set", () => {
    expect(
      countOpen([
        { open: true, archived: false }, // open
        { open: false, archived: false }, // closed
        { open: true, archived: true }, // archived (not counted)
        { open: false, archived: true }, // archived
        { open: true, archived: false }, // open
      ]),
    ).toBe(2);
  });

  it("returns 0 for an empty set", () => {
    expect(countOpen([])).toBe(0);
  });
});
