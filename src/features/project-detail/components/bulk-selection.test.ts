import { describe, it, expect } from "vitest";
import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  selectedBulkActionKind,
  pruneMissingSelections,
} from "./bulk-selection";

function s(
  name: string,
  archived: boolean,
): Pick<SessionListItem, "sessionName" | "archived"> {
  return { sessionName: name, archived };
}

describe("selectedBulkActionKind", () => {
  it('returns "archive" when no selected rows are archived', () => {
    const sessions = [s("a", false), s("b", false)];
    const selected = new Set(["a", "b"]);
    expect(selectedBulkActionKind(selected, sessions)).toBe("archive");
  });

  it('returns "archive" when only some selected rows are archived', () => {
    const sessions = [s("a", true), s("b", false)];
    const selected = new Set(["a", "b"]);
    expect(selectedBulkActionKind(selected, sessions)).toBe("archive");
  });

  it('returns "unarchive" when every selected row is archived', () => {
    const sessions = [s("a", true), s("b", true), s("c", false)];
    const selected = new Set(["a", "b"]);
    expect(selectedBulkActionKind(selected, sessions)).toBe("unarchive");
  });

  it('returns "archive" for empty selection (default)', () => {
    expect(selectedBulkActionKind(new Set(), [])).toBe("archive");
  });

  it("ignores selected names not present in sessions", () => {
    const sessions = [s("a", true)];
    const selected = new Set(["a", "ghost"]);
    expect(selectedBulkActionKind(selected, sessions)).toBe("unarchive");
  });
});

describe("pruneMissingSelections", () => {
  it("drops names that are no longer present in sessions", () => {
    const selected = new Set(["a", "b", "c"]);
    const sessions = [s("a", false), s("c", false)];
    const next = pruneMissingSelections(selected, sessions);
    expect([...next].sort()).toEqual(["a", "c"]);
  });

  it("returns the same Set instance when no pruning is needed", () => {
    const selected = new Set(["a", "b"]);
    const sessions = [s("a", false), s("b", false)];
    const next = pruneMissingSelections(selected, sessions);
    expect(next).toBe(selected);
  });

  it("returns an empty Set when every selected name is missing", () => {
    const selected = new Set(["a", "b"]);
    const next = pruneMissingSelections(selected, []);
    expect(next.size).toBe(0);
  });
});
