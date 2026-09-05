import { describe, expect, it, vi } from "vitest";
import type { PlanLintDefinition } from "./plan-lints";
import {
  lintCommittedSourceLocators,
  type CommittedSourceLocatorLintDeps,
} from "./committed-source-locator-lint";

const lintLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => lintLogger,
}));

const session = {
  sessionName: "source-session",
  branchName: "csm/source-session",
  worktreePath: "/srv/worktrees/source-session",
} as const;

const headSha = "abc123def456abc123def456abc123def456abcd";

function definition(
  sourcesOfTruth: PlanLintDefinition["charter"]["sourcesOfTruth"],
): Pick<PlanLintDefinition, "charter"> {
  return { charter: { sourcesOfTruth } };
}

function deps(
  overrides: Partial<CommittedSourceLocatorLintDeps> = {},
): CommittedSourceLocatorLintDeps {
  return {
    getHeadCommit: vi.fn(async () => headSha),
    commitContainsPath: vi.fn(async () => true),
    ...overrides,
  };
}

describe("lintCommittedSourceLocators", () => {
  it("treats workflow document paths as materialized sources without probing git", async () => {
    const dependency = deps({ commitContainsPath: async () => false });
    const warnings = await lintCommittedSourceLocators(
      definition([
        { id: "source-input", locator: ".cc/graph-workflow-docs/input.md" },
        {
          id: "context-spec",
          locator: ".cc/graph-workflow-docs/spec/demo/implement.md",
        },
      ]),
      session,
      dependency,
    );
    expect(warnings).toEqual([]);
    expect(dependency.getHeadCommit).not.toHaveBeenCalled();
  });

  it("pins one HEAD snapshot and reports missing sources in definition order with its server-derived substrate", async () => {
    const getHeadCommit = vi.fn(async () => headSha);
    const commitContainsPath = vi.fn(
      async (_worktreePath: string, _sha: string, locator: string) =>
        locator === "docs/present.md",
    );

    const warnings = await lintCommittedSourceLocators(
      definition([
        { id: "first-missing", locator: "docs/first.md" },
        { id: "present", locator: "docs/present.md" },
        { id: "last-missing", locator: "docs/last.md" },
      ]),
      session,
      { getHeadCommit, commitContainsPath },
    );

    expect(getHeadCommit).toHaveBeenCalledOnce();
    expect(getHeadCommit).toHaveBeenCalledWith(session.worktreePath);
    expect(commitContainsPath).toHaveBeenNthCalledWith(
      1,
      session.worktreePath,
      headSha,
      "docs/first.md",
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.path)).toEqual([
      "definition.charter.sourcesOfTruth.0.locator",
      "definition.charter.sourcesOfTruth.2.locator",
    ]);
    expect(warnings[0]?.message).toMatch(
      /^lint\/source-locator-unresolvable: .*"first-missing".*"docs\/first\.md"/,
    );
    for (const warning of warnings) {
      expect(warning.message).toContain('session "source-session"');
      expect(warning.message).toContain('branch "csm/source-session"');
      expect(warning.message).toContain(`commit ${headSha}`);
    }
  });

  it("defers unresolved input placeholders and does not probe lexically invalid locators", async () => {
    const commitContainsPath = vi.fn(async () => true);

    await expect(
      lintCommittedSourceLocators(
        definition([
          { id: "parameterized", locator: "docs/{{inputs.feature}}.md" },
          { id: "url", locator: "https://example.test/spec" },
          { id: "absolute", locator: "/etc/hosts" },
          { id: "escape", locator: "../outside.md" },
          { id: "concrete", locator: "docs/concrete.md" },
        ]),
        session,
        deps({ commitContainsPath }),
      ),
    ).resolves.toEqual([]);
    expect(commitContainsPath).toHaveBeenCalledOnce();
    expect(commitContainsPath).toHaveBeenCalledWith(
      session.worktreePath,
      headSha,
      "docs/concrete.md",
    );
  });

  it.each([
    ["HEAD throws", vi.fn(async () => Promise.reject(new Error("not a repo")))],
    ["HEAD is absent", vi.fn(async () => null)],
  ])(
    "fails open when %s instead of masquerading as source absence",
    async (_case, getHeadCommit) => {
      lintLogger.warn.mockClear();
      const commitContainsPath = vi.fn(async () => false);

      await expect(
        lintCommittedSourceLocators(
          definition([{ id: "design", locator: "docs/design.md" }]),
          session,
          { getHeadCommit, commitContainsPath },
        ),
      ).resolves.toEqual([]);
      expect(commitContainsPath).not.toHaveBeenCalled();
      expect(lintLogger.warn).toHaveBeenCalledWith(
        "workflow.source-locator.head-unresolved",
        expect.objectContaining({
          sessionName: session.sessionName,
          branch: session.branchName,
          worktreePath: session.worktreePath,
        }),
      );
    },
  );

  it("fails open for one Git probe failure while still reporting later proven absence", async () => {
    lintLogger.warn.mockClear();
    const commitContainsPath = vi
      .fn<CommittedSourceLocatorLintDeps["commitContainsPath"]>()
      .mockRejectedValueOnce(new Error("bad object"))
      .mockResolvedValueOnce(false);

    const warnings = await lintCommittedSourceLocators(
      definition([
        { id: "uncertain", locator: "docs/uncertain.md" },
        { id: "missing", locator: "docs/missing.md" },
      ]),
      session,
      deps({ commitContainsPath }),
    );

    expect(warnings).toEqual([
      {
        path: "definition.charter.sourcesOfTruth.1.locator",
        message: expect.stringContaining('source "missing"'),
      },
    ]);
    expect(lintLogger.warn).toHaveBeenCalledWith(
      "workflow.source-locator.commit-probe-failed",
      expect.objectContaining({
        sessionName: session.sessionName,
        branch: session.branchName,
        sha: headSha,
        sourceId: "uncertain",
        locator: "docs/uncertain.md",
      }),
    );
  });
});
