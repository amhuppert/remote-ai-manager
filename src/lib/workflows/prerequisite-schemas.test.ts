import { describe, expect, it } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  graphWorkflowExecutionSchema,
  normalizeSkillReference,
  prerequisiteSchema,
  workflowSemanticDefinitionSchema,
} from "./schemas";

function baseExecution(): Record<string, unknown> {
  return {
    id: "wf-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "pending",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function baseDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    executionContexts: [
      {
        id: "context-1",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "All tasks are complete and verified.",
      },
    ],
    tasks: [],
    edges: [],
  };
}

describe("normalizeSkillReference", () => {
  it("strips a single leading sigil and trims ASCII whitespace, sharing one normalized reference", () => {
    expect(normalizeSkillReference("kiro-spec-design")).toBe(
      "kiro-spec-design",
    );
    expect(normalizeSkillReference("/kiro-spec-design")).toBe(
      "kiro-spec-design",
    );
    expect(normalizeSkillReference("$kiro-spec-design")).toBe(
      "kiro-spec-design",
    );
    expect(normalizeSkillReference("  \t/kiro-spec-design \n")).toBe(
      "kiro-spec-design",
    );
  });

  it("removes AT MOST ONE leading sigil", () => {
    expect(normalizeSkillReference("//kiro")).toBe("/kiro");
    expect(normalizeSkillReference("/$kiro")).toBe("$kiro");
  });

  it("preserves case and namespace separators; performs no translation", () => {
    // `:` and `-` are significant and distinct: no colon-to-hyphen translation.
    expect(normalizeSkillReference("kiro:spec-init")).toBe("kiro:spec-init");
    expect(normalizeSkillReference("kiro-spec-init")).toBe("kiro-spec-init");
    expect(normalizeSkillReference("kiro:spec-init")).not.toBe(
      normalizeSkillReference("kiro-spec-init"),
    );
    // No case folding.
    expect(normalizeSkillReference("Kiro-Spec")).toBe("Kiro-Spec");
  });

  it("normalizes a sigil-only or whitespace-only reference to empty", () => {
    expect(normalizeSkillReference("/")).toBe("");
    expect(normalizeSkillReference("$")).toBe("");
    expect(normalizeSkillReference("   ")).toBe("");
  });
});

describe("prerequisiteSchema", () => {
  it("parses a path prerequisite with an optional label", () => {
    const parsed = prerequisiteSchema.parse({
      kind: "path",
      path: ".kiro/specs",
      label: "Kiro specs directory",
    });

    expect(parsed).toEqual({
      kind: "path",
      path: ".kiro/specs",
      label: "Kiro specs directory",
    });
  });

  it("parses a backend-scoped skill prerequisite", () => {
    const parsed = prerequisiteSchema.parse({
      kind: "skill",
      skill: "/kiro-spec-design",
      backend: "claude",
    });

    expect(parsed).toEqual({
      kind: "skill",
      skill: "/kiro-spec-design",
      backend: "claude",
    });
  });

  it("parses a backend-unscoped skill prerequisite", () => {
    const parsed = prerequisiteSchema.parse({
      kind: "skill",
      skill: "kiro:spec-init",
    });

    expect(parsed).toEqual({
      kind: "skill",
      skill: "kiro:spec-init",
    });
  });

  it("rejects a non-empty-after-normalization-empty skill reference", () => {
    expect(() =>
      prerequisiteSchema.parse({ kind: "skill", skill: "/" }),
    ).toThrow();
    expect(() =>
      prerequisiteSchema.parse({ kind: "skill", skill: "   " }),
    ).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() =>
      prerequisiteSchema.parse({ kind: "path", path: "" }),
    ).toThrow();
  });

  it("rejects an empty label when present", () => {
    expect(() =>
      prerequisiteSchema.parse({
        kind: "path",
        path: ".kiro",
        label: "",
      }),
    ).toThrow();
  });

  it("rejects a backend field on a path variant (.strict())", () => {
    expect(() =>
      prerequisiteSchema.parse({
        kind: "path",
        path: ".kiro",
        backend: "claude",
      }),
    ).toThrow();
  });

  it("rejects an unknown/extra field on any variant (.strict())", () => {
    expect(() =>
      prerequisiteSchema.parse({
        kind: "path",
        path: ".kiro",
        nonsense: true,
      }),
    ).toThrow();
    expect(() =>
      prerequisiteSchema.parse({
        kind: "skill",
        skill: "kiro-spec-design",
        rationale: "should be label only",
      }),
    ).toThrow();
  });

  it("rejects an unknown backend value on a skill variant", () => {
    expect(() =>
      prerequisiteSchema.parse({
        kind: "skill",
        skill: "kiro-spec-design",
        backend: "gemini",
      }),
    ).toThrow();
  });

  it("rejects an absolute path with a per-prerequisite locator", () => {
    const result = prerequisiteSchema.safeParse({
      kind: "path",
      path: "/etc/passwd",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("path");
      expect(result.error.issues[0]?.message).toMatch(/absolute|worktree/i);
    }
  });

  it("rejects a path containing a .. parent-directory segment with a per-prerequisite locator", () => {
    const result = prerequisiteSchema.safeParse({
      kind: "path",
      path: "../escape",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("path");
      expect(result.error.issues[0]?.message).toMatch(/\.\.|parent/i);
    }
  });

  it("rejects a .. segment in the middle of a path", () => {
    expect(() =>
      prerequisiteSchema.parse({ kind: "path", path: "a/../b" }),
    ).toThrow();
  });

  it("accepts a literal '..' substring that is not a path segment", () => {
    // `..` only escapes as a path SEGMENT; a filename like `foo..bar` is fine.
    const parsed = prerequisiteSchema.parse({
      kind: "path",
      path: "docs/foo..bar.md",
    });

    expect(parsed).toMatchObject({ kind: "path", path: "docs/foo..bar.md" });
  });
});

describe("workflowSemanticDefinitionSchema prerequisites block", () => {
  it("parses a definition declaring prerequisites of every kind without loss", () => {
    const input = {
      ...baseDefinition(),
      prerequisites: [
        { kind: "path", path: ".kiro/specs", label: "Kiro specs" },
        { kind: "skill", skill: "/kiro-spec-design", backend: "claude" },
        { kind: "skill", skill: "kiro:spec-init" },
      ],
    };

    const parsed = workflowSemanticDefinitionSchema.parse(input);

    expect(parsed.prerequisites).toEqual([
      { kind: "path", path: ".kiro/specs", label: "Kiro specs" },
      { kind: "skill", skill: "/kiro-spec-design", backend: "claude" },
      { kind: "skill", skill: "kiro:spec-init" },
    ]);

    // Re-serialize (re-parse the parsed object) is stable.
    expect(
      workflowSemanticDefinitionSchema.parse(parsed).prerequisites,
    ).toEqual(parsed.prerequisites);
  });

  it("defaults prerequisites to an empty list for a legacy definition with no prerequisites field", () => {
    const parsed = workflowSemanticDefinitionSchema.parse(baseDefinition());

    expect(parsed.prerequisites).toEqual([]);
  });

  it("keeps prerequisites disjoint from the parameters block", () => {
    const parsed = workflowSemanticDefinitionSchema.parse({
      ...baseDefinition(),
      parameters: [{ type: "string", name: "feature", label: "Feature" }],
      prerequisites: [{ kind: "path", path: ".kiro" }],
    });

    expect(parsed.parameters).toHaveLength(1);
    expect(parsed.prerequisites).toEqual([{ kind: "path", path: ".kiro" }]);
  });

  it("rejects a definition with an invalid prerequisite (absolute path)", () => {
    expect(() =>
      workflowSemanticDefinitionSchema.parse({
        ...baseDefinition(),
        prerequisites: [{ kind: "path", path: "/abs" }],
      }),
    ).toThrow();
  });
});

describe("graphWorkflowExecutionSchema launchedTier annotation", () => {
  it("parses an execution carrying a launchedTier value without loss", () => {
    const parsed = graphWorkflowExecutionSchema.parse({
      ...baseExecution(),
      launchedTier: "global",
    });

    expect(parsed.launchedTier).toBe("global");

    // Re-serialize (re-parse the parsed object) is stable.
    expect(graphWorkflowExecutionSchema.parse(parsed).launchedTier).toBe(
      "global",
    );
  });

  it("defaults launchedTier to 'project' for a legacy execution that omits it", () => {
    const parsed = graphWorkflowExecutionSchema.parse(baseExecution());

    expect(parsed.launchedTier).toBe("project");
  });

  it("rejects an unknown launchedTier value", () => {
    expect(() =>
      graphWorkflowExecutionSchema.parse({
        ...baseExecution(),
        launchedTier: "team",
      }),
    ).toThrow();
  });
});
