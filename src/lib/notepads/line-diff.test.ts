import { describe, expect, it } from "vitest";

import { diffNotepadLines } from "./line-diff";

describe("diffNotepadLines", () => {
  it("interleaves a mid-document replacement in document order", () => {
    expect(
      diffNotepadLines("alpha\nbeta\ngamma", "alpha\ndelta\ngamma"),
    ).toEqual([
      { kind: "unchanged", text: "alpha" },
      { kind: "removed", text: "beta" },
      { kind: "added", text: "delta" },
      { kind: "unchanged", text: "gamma" },
    ]);
  });

  it("anchors changes at both ends where they happened, not trailing", () => {
    // The prototype's trailing-additions rendering is explicitly NOT the
    // contract: an edit at the top must render at the top.
    expect(
      diffNotepadLines("intro\nmiddle\nend", "intro two\nmiddle\nend two"),
    ).toEqual([
      { kind: "removed", text: "intro" },
      { kind: "added", text: "intro two" },
      { kind: "unchanged", text: "middle" },
      { kind: "removed", text: "end" },
      { kind: "added", text: "end two" },
    ]);
  });

  it("reports a pure insertion without disturbing surrounding lines", () => {
    expect(diffNotepadLines("alpha\ngamma", "alpha\nbeta\ngamma")).toEqual([
      { kind: "unchanged", text: "alpha" },
      { kind: "added", text: "beta" },
      { kind: "unchanged", text: "gamma" },
    ]);
  });

  it("reports a pure removal without disturbing surrounding lines", () => {
    expect(diffNotepadLines("alpha\nbeta\ngamma", "alpha\ngamma")).toEqual([
      { kind: "unchanged", text: "alpha" },
      { kind: "removed", text: "beta" },
      { kind: "unchanged", text: "gamma" },
    ]);
  });

  it("marks every line added when there is no prior content", () => {
    expect(diffNotepadLines("", "alpha\nbeta")).toEqual([
      { kind: "added", text: "alpha" },
      { kind: "added", text: "beta" },
    ]);
  });

  it("marks every line removed when the target is empty", () => {
    expect(diffNotepadLines("alpha\nbeta", "")).toEqual([
      { kind: "removed", text: "alpha" },
      { kind: "removed", text: "beta" },
    ]);
  });

  it("reports identical revisions as fully unchanged", () => {
    expect(diffNotepadLines("alpha\nbeta", "alpha\nbeta")).toEqual([
      { kind: "unchanged", text: "alpha" },
      { kind: "unchanged", text: "beta" },
    ]);
  });

  it("keeps a large document's single-line change local, not wholesale", () => {
    // Two ~3000-line revisions differing by one middle line: a naive LCS
    // table over the full inputs would blow the cell bound and fall back to
    // removed-everything-added-everything. The common prefix and suffix must
    // be trimmed first so the diff stays a single replacement.
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const edited = [...lines];
    edited[1500] = "line 1500 — edited";

    const diff = diffNotepadLines(lines.join("\n"), edited.join("\n"));

    expect(diff.filter((line) => line.kind !== "unchanged")).toEqual([
      { kind: "removed", text: "line 1500" },
      { kind: "added", text: "line 1500 — edited" },
    ]);
    expect(diff.length).toBe(3001);
    expect(diff[1500]).toEqual({ kind: "removed", text: "line 1500" });
  });

  it("keeps changes at both ends of a large document local, not wholesale", () => {
    // No unchanged edge exists to trim here, so the changed span is the whole
    // 3000×3000 input — past the LCS table bound. The diff must still anchor
    // on the unchanged interior instead of reporting a wholesale replacement.
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const edited = [...lines];
    edited[0] = "line 0 — edited";
    edited[2999] = "line 2999 — edited";

    const diff = diffNotepadLines(lines.join("\n"), edited.join("\n"));

    expect(diff.filter((line) => line.kind !== "unchanged")).toEqual([
      { kind: "removed", text: "line 0" },
      { kind: "added", text: "line 0 — edited" },
      { kind: "removed", text: "line 2999" },
      { kind: "added", text: "line 2999 — edited" },
    ]);
    expect(diff.length).toBe(3002);
  });

  it("keeps end edits local when the large unchanged interior is one repeated line", () => {
    // No line here is unique — the interior is 2998 identical lines — so a
    // unique-line anchor cannot exist. The diff must still align the repeated
    // interior instead of collapsing into a wholesale replacement.
    const interior = Array.from({ length: 2998 }, () => "same");
    const before = ["start A", ...interior, "end A"];
    const after = ["start B", ...interior, "end B"];

    const diff = diffNotepadLines(before.join("\n"), after.join("\n"));

    expect(diff.filter((line) => line.kind !== "unchanged")).toEqual([
      { kind: "removed", text: "start A" },
      { kind: "added", text: "start B" },
      { kind: "removed", text: "end A" },
      { kind: "added", text: "end B" },
    ]);
    expect(diff.length).toBe(3002);
  });

  it("reports fully disjoint documents as a wholesale replacement", () => {
    // With no shared line at all, removed-everything-added-everything IS the
    // exact diff — the only remaining case that renders wholesale.
    expect(diffNotepadLines("alpha\nbeta", "gamma\ndelta")).toEqual([
      { kind: "removed", text: "alpha" },
      { kind: "removed", text: "beta" },
      { kind: "added", text: "gamma" },
      { kind: "added", text: "delta" },
    ]);
  });

  it("keeps a repeated line's change local to the edited occurrence", () => {
    expect(
      diffNotepadLines(
        "task\n- [ ] a\ntask\n- [ ] b",
        "task\n- [x] a\ntask\n- [ ] b",
      ),
    ).toEqual([
      { kind: "unchanged", text: "task" },
      { kind: "removed", text: "- [ ] a" },
      { kind: "added", text: "- [x] a" },
      { kind: "unchanged", text: "task" },
      { kind: "unchanged", text: "- [ ] b" },
    ]);
  });
});
