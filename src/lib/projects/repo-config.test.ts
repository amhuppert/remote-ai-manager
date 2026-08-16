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
          command: {
            full: "scripts/pre-merge-validate-full.sh",
            changed: "scripts/pre-merge-validate.sh",
          },
          cost: 5,
          timeoutMs: 3_600_000,
          pathArgs: "forbid",
        },
        format: {
          command: {
            full: "scripts/validate/format-full.sh",
            changed: "scripts/validate/format.sh",
          },
          cost: 1,
          description: "Format project files",
          pathArgs: "forbid",
        },
        lint: {
          command: {
            full: "scripts/validate/lint-full.sh",
            changed: "scripts/validate/lint.sh",
          },
          cost: 2,
          description: "Lint project files",
          pathArgs: "forbid",
        },
        typecheck: {
          command: { full: "scripts/validate/typecheck.sh" },
          cost: 4,
          timeoutMs: 3_600_000,
          description: "Run full-project static and build checks",
          pathArgs: "forbid",
        },
        test: {
          command: {
            full: "scripts/validate/test-full-suite.sh",
            changed: "scripts/validate/test.sh",
          },
          cost: { full: 5, changed: 5, paths: { base: 2, perPath: 1 } },
          timeoutMs: 3_600_000,
          description:
            "Run unit tests in a worker pool clamped to the machine's memory budget",
          pathArgs: "paths",
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
            lint: {
              command: { full: "scripts/validate/lint.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
            test: {
              command: {
                full: "scripts/validate/test-full-suite.sh",
                changed: "scripts/validate/test.sh",
              },
              cost: 8,
              timeoutMs: 900_000,
              pathArgs: "paths",
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
    expect(result?.validation?.commands.lint?.pathArgs).toBe("forbid");
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
