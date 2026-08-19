import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionRecord } from "@/lib/workflow-graph/criteria/criterion-records";
import { lintPlanSemantics, type PlanLintDefinition } from "./plan-lints";

function criteria(
  count: number,
  statement = "Behavior is pinned",
): CriterionRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ac-${index + 1}`,
    statement,
  }));
}

function makeLintDefinition(
  overrides: Partial<PlanLintDefinition> = {},
): PlanLintDefinition {
  return {
    charter: {
      sourcesOfTruth: [{ id: "design-doc", locator: "docs/design.md" }],
    },
    executionContexts: [
      {
        id: "context-implement",
        description: "Implement the feature",
        acceptanceCriteria: criteria(2),
      },
    ],
    tasks: [{ id: "task-1", instructions: "Write the module" }],
    ...overrides,
  };
}

/** Every message a lint emits, for the "produces none" assertions. */
function messages(warnings: { message: string }[]): string[] {
  return warnings.map((warning) => warning.message);
}

describe("lintPlanSemantics — criteria density", () => {
  it("warns naming the context when a context declares more than 12 criteria", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-obligations",
            acceptanceCriteria: criteria(13),
          },
        ],
      }),
    );

    expect(warnings).toContainEqual({
      path: "definition.executionContexts.0.acceptanceCriteria",
      message: expect.stringMatching(
        /^lint\/criteria-density: .*"context-obligations".*13/,
      ),
    });
  });

  it("does not warn at exactly 12 criteria", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          { id: "context-ok", acceptanceCriteria: criteria(12) },
        ],
      }),
    );

    expect(messages(warnings)).toEqual([]);
  });

  it("warns when a single criterion statement exceeds 600 characters", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-blob",
            acceptanceCriteria: [
              { id: "ac-1", statement: "x".repeat(601) },
              { id: "ac-2", statement: "y".repeat(600) },
            ],
          },
        ],
      }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
        message: expect.stringMatching(
          /^lint\/criteria-density: .*"ac-1".*"context-blob".*601/,
        ),
      },
    ]);
  });

  it("counts legacy prose criteria as the single wrapped record", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          { id: "context-prose", acceptanceCriteria: "z".repeat(601) },
        ],
      }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
        message: expect.stringContaining('"ac-1"'),
      },
    ]);
  });
});

describe("lintPlanSemantics — open quantifiers", () => {
  it.each([
    ["every", "Every call site is migrated"],
    ["all", "All lanes report a verdict"],
    ["complete", "The sweep is complete"],
    ["maximal", "The fixture is maximal"],
  ])("warns on the open quantifier %s", (quantifier, statement) => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-sweep",
            acceptanceCriteria: [{ id: "ac-7", statement }],
          },
        ],
      }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
        message: expect.stringMatching(
          new RegExp(
            `^lint/open-quantifier: .*"ac-7".*"context-sweep".*${quantifier}`,
          ),
        ),
      },
    ]);
  });

  it("does not warn when a quantifier only appears inside a longer word", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-scoped",
            acceptanceCriteria: [
              {
                id: "ac-1",
                statement:
                  "The completed allowlist in registry.ts names three commands",
              },
            ],
          },
        ],
      }),
    );

    expect(messages(warnings)).toEqual([]);
  });

  it("advises an inventoried surface or a split", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-sweep",
            acceptanceCriteria: [
              { id: "ac-1", statement: "ALL callers are updated" },
            ],
          },
        ],
      }),
    );

    expect(warnings[0]?.message).toMatch(/inventor/i);
    expect(warnings[0]?.message).toMatch(/split/i);
  });
});

describe("lintPlanSemantics — source locator resolvability", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "cc-plan-lints-"));
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "design.md"), "# design\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not warn for a worktree-relative locator that resolves", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        charter: {
          sourcesOfTruth: [
            { id: "design-doc", locator: "docs/design.md" },
            { id: "design-dir", locator: "docs" },
          ],
        },
      }),
      { projectRoot: root },
    );

    expect(messages(warnings)).toEqual([]);
  });

  it("warns naming the source id for a locator that does not exist", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        charter: {
          sourcesOfTruth: [{ id: "ghost-spec", locator: "docs/ghost.md" }],
        },
      }),
      { projectRoot: root },
    );

    expect(warnings).toEqual([
      {
        path: "definition.charter.sourcesOfTruth.0.locator",
        message: expect.stringMatching(
          /^lint\/source-locator-unresolvable: .*"ghost-spec".*docs\/ghost\.md/,
        ),
      },
    ]);
  });

  it.each([
    ["a URL scheme", "https://internal.example/ledger"],
    ["an absolute path", "/etc/hosts"],
  ])("warns for %s even when the target exists", (_label, locator) => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        charter: { sourcesOfTruth: [{ id: "external", locator }] },
      }),
      { projectRoot: root },
    );

    expect(warnings).toEqual([
      {
        path: "definition.charter.sourcesOfTruth.0.locator",
        message: expect.stringContaining('"external"'),
      },
    ]);
  });

  it("warns for a relative locator that escapes the project root", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        charter: {
          sourcesOfTruth: [{ id: "sibling", locator: "../elsewhere/spec.md" }],
        },
      }),
      { projectRoot: root },
    );

    expect(messages(warnings)).toHaveLength(1);
  });

  it("skips the lint entirely when no project root is available", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        charter: {
          sourcesOfTruth: [
            { id: "ghost-spec", locator: "docs/ghost.md" },
            { id: "external", locator: "https://internal.example/ledger" },
          ],
        },
      }),
    );

    expect(messages(warnings)).toEqual([]);
  });
});

describe("lintPlanSemantics — oversized prose", () => {
  it("warns naming the task when instructions exceed 8000 characters", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        tasks: [{ id: "task-blob", instructions: "i".repeat(8001) }],
      }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.tasks.0.instructions",
        message: expect.stringMatching(
          /^lint\/oversized-prose: .*"task-blob".*8001/,
        ),
      },
    ]);
  });

  it("does not warn at exactly 8000 characters of instructions", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        tasks: [{ id: "task-ok", instructions: "i".repeat(8000) }],
      }),
    );

    expect(messages(warnings)).toEqual([]);
  });

  it("warns naming the context when a description exceeds 2000 characters", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-verbose",
            description: "d".repeat(2001),
            acceptanceCriteria: criteria(1),
          },
        ],
      }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.executionContexts.0.description",
        message: expect.stringMatching(
          /^lint\/oversized-prose: .*"context-verbose".*2001/,
        ),
      },
    ]);
  });

  it("does not warn at exactly 2000 characters of description", () => {
    const warnings = lintPlanSemantics(
      makeLintDefinition({
        executionContexts: [
          {
            id: "context-ok",
            description: "d".repeat(2000),
            acceptanceCriteria: criteria(1),
          },
        ],
      }),
    );

    expect(messages(warnings)).toEqual([]);
  });
});

describe("lintPlanSemantics — clean plan", () => {
  it("returns no warnings for a plan that trips nothing", () => {
    expect(lintPlanSemantics(makeLintDefinition())).toEqual([]);
  });
});
