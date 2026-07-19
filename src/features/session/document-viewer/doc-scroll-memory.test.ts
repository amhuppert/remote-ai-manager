import { describe, it, expect, beforeEach } from "vitest";
import {
  saveDocScroll,
  readDocScroll,
  clearDocScrollMemory,
} from "./doc-scroll-memory";

const DOC_A = {
  projectName: "proj",
  sessionName: "sess-a",
  docPath: "docs/plan.md",
  title: "Plan",
};

describe("doc-scroll-memory", () => {
  beforeEach(clearDocScrollMemory);

  it("round-trips a saved scroll position", () => {
    saveDocScroll(DOC_A, 420);
    expect(readDocScroll(DOC_A)).toBe(420);
  });

  it("returns undefined for a document never scrolled", () => {
    expect(readDocScroll(DOC_A)).toBeUndefined();
  });

  it("keeps the same docPath in different sessions distinct", () => {
    const inOtherSession = { ...DOC_A, sessionName: "sess-b" };
    saveDocScroll(DOC_A, 100);
    saveDocScroll(inOtherSession, 900);
    expect(readDocScroll(DOC_A)).toBe(100);
    expect(readDocScroll(inOtherSession)).toBe(900);
  });

  it("overwrites with the latest position", () => {
    saveDocScroll(DOC_A, 100);
    saveDocScroll(DOC_A, 250);
    expect(readDocScroll(DOC_A)).toBe(250);
  });
});
