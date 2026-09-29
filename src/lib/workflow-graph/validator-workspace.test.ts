import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareValidatorWorkspace } from "./validator-workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function candidate() {
  const root = mkdtempSync(path.join(tmpdir(), "cc-validator-workspace-"));
  roots.push(root);
  return {
    executionId: "execution-1",
    contextId: "context-1",
    assignmentId: "reviewer-1",
    worktreePath: root,
  };
}

describe("prepareValidatorWorkspace", () => {
  it("creates reusable assignment-private scratch under the canonical candidate's .cc/temp", () => {
    const input = candidate();
    const first = prepareValidatorWorkspace(input);
    expect(first.worktreePath).toBe(realpathSync(input.worktreePath));
    expect(first.scratchDirectory).toBe(
      path.join(
        first.worktreePath,
        ".cc/temp/validators/execution-1/context-1/reviewer-1",
      ),
    );
    expect(existsSync(first.scratchDirectory)).toBe(true);
    expect(prepareValidatorWorkspace(input)).toEqual(first);
    expect(
      prepareValidatorWorkspace({ ...input, assignmentId: "reviewer-2" })
        .scratchDirectory,
    ).not.toBe(first.scratchDirectory);
  });

  it("keeps authored path segments within .cc/temp", () => {
    const input = candidate();
    const workspace = prepareValidatorWorkspace({
      ...input,
      contextId: "../../other",
      assignmentId: "../../reviewer",
    });
    const relative = path.relative(
      path.join(workspace.worktreePath, ".cc/temp/validators"),
      workspace.scratchDirectory,
    );
    expect(relative.split(path.sep)).toHaveLength(3);
    expect(relative.split(path.sep)).not.toContain("..");
  });

  it("refuses an unavailable candidate before dispatch", () => {
    const input = candidate();
    expect(() =>
      prepareValidatorWorkspace({
        ...input,
        worktreePath: path.join(input.worktreePath, "missing"),
      }),
    ).toThrow(/Cannot prepare the validator workspace/);
  });
});
