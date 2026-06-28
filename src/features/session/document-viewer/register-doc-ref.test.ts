import { describe, it, expect } from "vitest";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import { resolveRegisteredDoc } from "./register-doc-ref";

const WORKTREE = "/repos/proj/.worktrees/feat";

function doc(filePath: string): ReferenceDocument {
  return { id: "id-1", filePath, description: "", createdAt: "2026-01-01" };
}

describe("resolveRegisteredDoc", () => {
  it("normalizes an absolute path inside the worktree to a relative docPath", () => {
    const result = resolveRegisteredDoc(
      doc(`${WORKTREE}/.kiro/specs/x/design.md`),
      "proj",
      "feat",
      WORKTREE,
    );
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.ref.docPath).toBe(".kiro/specs/x/design.md");
      expect(result.ref.title).toBe("design.md");
      expect(result.ref.projectName).toBe("proj");
      expect(result.ref.sessionName).toBe("feat");
    }
  });

  it("passes a worktree-relative path through unchanged", () => {
    const result = resolveRegisteredDoc(
      doc("docs/notes.md"),
      "proj",
      "feat",
      WORKTREE,
    );
    expect(result.available).toBe(true);
    if (result.available) expect(result.ref.docPath).toBe("docs/notes.md");
  });

  it("marks an absolute path outside the worktree as unavailable", () => {
    const result = resolveRegisteredDoc(
      doc("/etc/other/readme.md"),
      "proj",
      "feat",
      WORKTREE,
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("outside-worktree");
  });

  it("marks a non-markdown registered file as unavailable", () => {
    const result = resolveRegisteredDoc(
      doc(`${WORKTREE}/src/main.ts`),
      "proj",
      "feat",
      WORKTREE,
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("non-markdown");
  });
});
