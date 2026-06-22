import { describe, expect, it } from "vitest";

import type { WorkflowPrerequisite } from "@/lib/workflows/schemas";

import { containsPlaceholderOpener } from "./parameter-validation";
import { validatePrerequisites } from "./prerequisite-validation";

function pathPrereq(
  overrides: Partial<Extract<WorkflowPrerequisite, { kind: "path" }>> = {},
): WorkflowPrerequisite {
  return {
    kind: "path",
    path: "docs/charter.md",
    ...overrides,
  };
}

function skillPrereq(
  overrides: Partial<Extract<WorkflowPrerequisite, { kind: "skill" }>> = {},
): WorkflowPrerequisite {
  return {
    kind: "skill",
    skill: "kiro-spec-design",
    ...overrides,
  };
}

// Several rules guard against shapes the `.strict()` parse schema would normally
// catch (missing kind/identifier, unknown discriminant). Those parsed-invalid
// shapes can never come from a real `prerequisiteSchema` parse, so the tests
// construct them deliberately as the still-typed `WorkflowPrerequisite` the
// choke point would pass when given crafted/legacy input.
function malformedPrereq(value: unknown): WorkflowPrerequisite {
  return value as WorkflowPrerequisite;
}

describe("validatePrerequisites", () => {
  it("accepts an empty prerequisite list", () => {
    expect(validatePrerequisites([])).toEqual([]);
  });

  it("accepts a worktree-relative path prerequisite", () => {
    expect(validatePrerequisites([pathPrereq()])).toEqual([]);
  });

  it("accepts a skill prerequisite without a backend", () => {
    expect(validatePrerequisites([skillPrereq()])).toEqual([]);
  });

  it("accepts a skill prerequisite with an optional backend", () => {
    expect(validatePrerequisites([skillPrereq({ backend: "codex" })])).toEqual(
      [],
    );
  });

  it("accepts a path prerequisite with a normalizable filename containing dots", () => {
    expect(
      validatePrerequisites([pathPrereq({ path: "foo..bar.md" })]),
    ).toEqual([]);
  });

  describe("known kind + identifier (R4.2, R4.4)", () => {
    it("rejects a prerequisite missing its kind, identifying its index", () => {
      const errors = validatePrerequisites([
        malformedPrereq({ path: "docs/x.md" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-unknown-kind");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects an unknown kind discriminant", () => {
      const errors = validatePrerequisites([
        malformedPrereq({ kind: "command", value: "ls" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-unknown-kind");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a path prerequisite missing its path identifier", () => {
      const errors = validatePrerequisites([malformedPrereq({ kind: "path" })]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-missing-identifier");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a path prerequisite with an empty path identifier", () => {
      const errors = validatePrerequisites([
        malformedPrereq({ kind: "path", path: "   " }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-missing-identifier");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a skill prerequisite missing its skill identifier", () => {
      const errors = validatePrerequisites([
        malformedPrereq({ kind: "skill" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-missing-identifier");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });
  });

  describe("empty normalized skill reference (R4.2b)", () => {
    it("rejects a skill reference that normalizes to empty (lone sigil)", () => {
      const errors = validatePrerequisites([skillPrereq({ skill: "/" })]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-empty-skill-reference");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a skill reference that normalizes to empty (whitespace + sigil)", () => {
      const errors = validatePrerequisites([skillPrereq({ skill: "  $ " })]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-empty-skill-reference");
    });
  });

  describe("worktree-relative path policy (R4.8)", () => {
    it("rejects an absolute POSIX path, identifying the prerequisite", () => {
      const errors = validatePrerequisites([
        pathPrereq({ path: "/etc/passwd" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-path-not-worktree-relative");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a path containing a '..' parent segment", () => {
      const errors = validatePrerequisites([
        pathPrereq({ path: "../outside/x.md" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-path-not-worktree-relative");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a '..' segment in the middle of a path", () => {
      const errors = validatePrerequisites([
        pathPrereq({ path: "docs/../../etc" }),
      ]);
      expect(
        errors.some(
          (e) => e.code === "prerequisite-path-not-worktree-relative",
        ),
      ).toBe(true);
    });
  });

  describe("placeholder rejection (R4.10)", () => {
    it("rejects a {{...}} occurrence in a path field", () => {
      const errors = validatePrerequisites([
        pathPrereq({ path: "docs/{{inputs.feature}}.md" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-contains-placeholder");
      expect(errors[0]?.field).toBe("prerequisites[0]");
    });

    it("rejects a {{...}} occurrence in a skill reference field", () => {
      const errors = validatePrerequisites([
        skillPrereq({ skill: "kiro-{{inputs.mode}}" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-contains-placeholder");
    });

    it("rejects a {{...}} occurrence in a label field", () => {
      const errors = validatePrerequisites([
        skillPrereq({ label: "needs {{inputs.x}}" }),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("prerequisite-contains-placeholder");
    });

    it("uses the SAME {{ detection as the upstream lint", () => {
      // A token the upstream lint flags (it keys on the `{{` opener) must also be
      // flagged here, proving the two lints share one detection primitive.
      const flaggedByUpstream = "x{{inputs.feature}}y";
      expect(containsPlaceholderOpener(flaggedByUpstream)).toBe(true);

      const errors = validatePrerequisites([
        pathPrereq({ path: flaggedByUpstream }),
      ]);
      expect(
        errors.some((e) => e.code === "prerequisite-contains-placeholder"),
      ).toBe(true);
    });

    it("does not flag a path that contains a single brace", () => {
      expect(containsPlaceholderOpener("docs/{not-a-token}.md")).toBe(false);
      expect(
        validatePrerequisites([pathPrereq({ path: "docs/{not-a-token}.md" })]),
      ).toEqual([]);
    });
  });

  describe("locators + collection (R4.4, R4.6)", () => {
    it("identifies the offending prerequisite by index across a list", () => {
      const errors = validatePrerequisites([
        pathPrereq(),
        pathPrereq({ path: "/absolute" }),
        skillPrereq(),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.field).toBe("prerequisites[1]");
    });

    it("collects every violation across the list (does not short-circuit)", () => {
      const errors = validatePrerequisites([
        pathPrereq({ path: "/absolute" }),
        skillPrereq({ skill: "/" }),
      ]);
      expect(errors).toHaveLength(2);
      expect(errors[0]?.field).toBe("prerequisites[0]");
      expect(errors[1]?.field).toBe("prerequisites[1]");
    });

    it("produces identical results for global and project definitions (tier-agnostic)", () => {
      // The function takes only the prerequisite list, so a "global" and a
      // "project" definition with the same prerequisites must validate identically.
      const prerequisites: WorkflowPrerequisite[] = [
        pathPrereq({ path: "../escape" }),
        skillPrereq({ backend: "claude" }),
      ];
      const globalResult = validatePrerequisites(prerequisites);
      const projectResult = validatePrerequisites(prerequisites);
      expect(globalResult).toEqual(projectResult);
      expect(globalResult).toHaveLength(1);
    });
  });
});
