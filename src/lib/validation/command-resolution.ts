import type { ValidationCommandConfig, ValidationScope } from "./schemas";
import { validatePathArgs, type PathArgsViolationKind } from "./path-args";

export type ValidationExecutionResolution =
  | {
      ok: true;
      executable: string;
      requestedScope: ValidationScope;
      effectiveScope: ValidationScope;
      pathArgs: "forbid" | "paths";
      scopePaths: string[];
    }
  | {
      ok: false;
      reason: "path_args_forbidden" | "path_args_require_changed";
      message: string;
    }
  | {
      ok: false;
      reason: "path_args_rejected";
      message: string;
      violation: PathArgsViolationKind;
      token: string;
    };

export function resolveValidationExecution(input: {
  profile: ValidationCommandConfig;
  requestedScope: ValidationScope;
  scopePaths: readonly string[];
  worktreePath: string;
}): ValidationExecutionResolution {
  const { profile, requestedScope, scopePaths, worktreePath } = input;

  if (scopePaths.length > 0 && requestedScope === "full") {
    return {
      ok: false,
      reason: "path_args_require_changed",
      message:
        "Path arguments require scope changed and cannot narrow a full run.",
    };
  }

  if (scopePaths.length > 0 && profile.command.changed === undefined) {
    return {
      ok: false,
      reason: "path_args_require_changed",
      message:
        "Path arguments require a native changed executable; this command falls back to full.",
    };
  }

  if (scopePaths.length > 0 && profile.pathArgs === "forbid") {
    return {
      ok: false,
      reason: "path_args_forbidden",
      message:
        'This command does not accept forwarded paths (pathArgs: "forbid").',
    };
  }

  const checked = validatePathArgs(scopePaths, worktreePath);
  if (!checked.ok) {
    return {
      ok: false,
      reason: "path_args_rejected",
      message: `Path argument "${checked.token}" was refused (${checked.kind}): forwarded values must be relative paths inside the target worktree.`,
      violation: checked.kind,
      token: checked.token,
    };
  }

  if (requestedScope === "full" || profile.command.changed === undefined) {
    return {
      ok: true,
      executable: profile.command.full,
      requestedScope,
      effectiveScope: "full",
      pathArgs: profile.pathArgs,
      scopePaths: checked.paths,
    };
  }

  return {
    ok: true,
    executable: profile.command.changed,
    requestedScope,
    effectiveScope: "changed",
    pathArgs: profile.pathArgs,
    scopePaths: checked.paths,
  };
}
