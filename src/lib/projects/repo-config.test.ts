import { describe, expect, it, vi } from "vitest";
import {
  createRepoConfig,
  readRepoConfig,
  type RepoConfigDeps,
} from "./repo-config";

function createTestDeps(): RepoConfigDeps {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    readFile: vi.fn().mockRejectedValue(new Error("file not found")),
  };
}

describe("readRepoConfig", () => {
  it("parses the checked-in project configuration through the production schema", async () => {
    const result = await readRepoConfig(process.cwd());

    expect(result?.validation).toEqual({
      commands: {
        "pre-merge": {
          command: "scripts/pre-merge-validate.sh",
          cost: 8,
          timeoutMs: 3_600_000,
          scopeArgs: "forbid",
        },
        format: {
          command: "scripts/validate/format.sh",
          cost: 1,
          description: "Format changed files",
          scopeArgs: "forbid",
        },
        lint: {
          command: "scripts/validate/lint.sh",
          cost: 2,
          description: "Lint changed files",
          scopeArgs: "forbid",
        },
        typecheck: {
          command: "scripts/validate/typecheck.sh",
          cost: 2,
          timeoutMs: 3_600_000,
          description: "Run full-project static and build checks",
          scopeArgs: "forbid",
        },
        test: {
          command: "scripts/validate/test.sh",
          cost: 8,
          timeoutMs: 3_600_000,
          description: "Run affected unit tests with eight workers",
          scopeArgs: "paths",
        },
      },
      preMerge: ["format", "lint", "typecheck", "test"],
      laneMerge: ["typecheck", "test"],
    });
    expect(result).not.toHaveProperty("preMergeCommand");
    expect(result).not.toHaveProperty("preMergeTimeoutMs");
  });

  it("returns null when no config file exists", async () => {
    const deps = createTestDeps();
    const { readRepoConfig } = createRepoConfig(deps);

    await expect(readRepoConfig("/projects/foo")).resolves.toBeNull();
  });

  it("parses the validation command registry", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.existsSync).mockReturnValue(true);
    vi.mocked(deps.readFile).mockResolvedValue(
      JSON.stringify({
        validation: {
          commands: {
            lint: { command: "scripts/validate/lint.sh", cost: 2 },
            test: {
              command: "scripts/validate/test.sh",
              cost: 8,
              timeoutMs: 900_000,
              scopeArgs: "paths",
            },
          },
          preMerge: ["lint", "test"],
          laneMerge: ["test"],
        },
      }),
    );
    const { readRepoConfig } = createRepoConfig(deps);

    const result = await readRepoConfig("/projects/foo");

    expect(result?.validation?.preMerge).toEqual(["lint", "test"]);
    expect(result?.validation?.laneMerge).toEqual(["test"]);
    expect(result?.validation?.commands.test?.cost).toBe(8);
    expect(result?.validation?.commands.lint?.scopeArgs).toBe("forbid");
  });

  it("rejects preMergeCommand with the registry replacement path", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.existsSync).mockReturnValue(true);
    vi.mocked(deps.readFile).mockResolvedValue(
      JSON.stringify({ preMergeCommand: "scripts/validate.sh" }),
    );
    const { readRepoConfig } = createRepoConfig(deps);

    await expect(readRepoConfig("/projects/foo")).rejects.toThrow(
      "validation.commands/preMerge",
    );
  });
});
