import { describe, expect, it } from "vitest";
import type { ValidationCommandConfig } from "./schemas";
import { resolveValidationExecution } from "./command-resolution";

const worktreePath = "/projects/app/.worktrees/feature";

function profile(
  overrides: Partial<ValidationCommandConfig> = {},
): ValidationCommandConfig {
  return {
    command: {
      full: "scripts/validate/test-full.sh",
      changed: "scripts/validate/test-changed.sh",
    },
    cost: 4,
    pathArgs: "paths",
    ...overrides,
  };
}

describe("resolveValidationExecution", () => {
  it.each([
    {
      name: "native changed",
      requestedScope: "changed" as const,
      command: profile().command,
      expectedExecutable: "scripts/validate/test-changed.sh",
      expectedEffectiveScope: "changed",
    },
    {
      name: "changed fallback",
      requestedScope: "changed" as const,
      command: { full: "scripts/validate/test-full.sh" },
      expectedExecutable: "scripts/validate/test-full.sh",
      expectedEffectiveScope: "full",
    },
    {
      name: "explicit full",
      requestedScope: "full" as const,
      command: profile().command,
      expectedExecutable: "scripts/validate/test-full.sh",
      expectedEffectiveScope: "full",
    },
  ])(
    "selects the $name executable",
    ({
      requestedScope,
      command,
      expectedExecutable,
      expectedEffectiveScope,
    }) => {
      const result = resolveValidationExecution({
        profile: profile({ command, pathArgs: "forbid" }),
        requestedScope,
        scopePaths: [],
        worktreePath,
      });

      expect(result).toMatchObject({
        ok: true,
        executable: expectedExecutable,
        requestedScope,
        effectiveScope: expectedEffectiveScope,
        scopePaths: [],
      });
    },
  );

  it("copies validated paths into a native changed execution", () => {
    const paths = ["src/a.test.ts"];
    const result = resolveValidationExecution({
      profile: profile(),
      requestedScope: "changed",
      scopePaths: paths,
      worktreePath,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveScope: "changed",
      scopePaths: paths,
    });
    if (result.ok) expect(result.scopePaths).not.toBe(paths);
  });

  it.each([
    {
      name: "explicit full",
      requestedScope: "full" as const,
      command: profile().command,
    },
    {
      name: "changed fallback",
      requestedScope: "changed" as const,
      command: { full: "scripts/validate/test-full.sh" },
    },
  ])("rejects paths for $name", ({ requestedScope, command }) => {
    const result = resolveValidationExecution({
      profile: profile({ command, pathArgs: "forbid" }),
      requestedScope,
      scopePaths: ["src/a.test.ts"],
      worktreePath,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "path_args_require_changed",
    });
  });

  it("rejects paths when the native changed profile forbids them", () => {
    expect(
      resolveValidationExecution({
        profile: profile({ pathArgs: "forbid" }),
        requestedScope: "changed",
        scopePaths: ["src/a.test.ts"],
        worktreePath,
      }),
    ).toMatchObject({ ok: false, reason: "path_args_forbidden" });
  });

  it.each(["--pool=threads", "/etc/passwd", "../outside.ts", ""])(
    "rejects unsafe path token %j",
    (token) => {
      expect(
        resolveValidationExecution({
          profile: profile(),
          requestedScope: "changed",
          scopePaths: [token],
          worktreePath,
        }),
      ).toMatchObject({
        ok: false,
        reason: "path_args_rejected",
        token,
      });
    },
  );
});
