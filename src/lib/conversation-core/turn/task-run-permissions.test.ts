/**
 * The workflow task-run permission literals, derived from the lane's role
 * rather than hardcoded at the dispatch site (R7.2, D6).
 */

import { describe, expect, it } from "vitest";
import { deriveTaskRunPermissions } from "./task-run-permissions";

const POLICY = {
  mode: "allowlist" as const,
  allowWrite: ["/private/tmp/lane", "/private/tmp/lane/tmp"],
  denyWrite: ["/private/repo/worktree"],
};

describe("deriveTaskRunPermissions", () => {
  it("keeps the write-capable configuration for a lane with no write envelope", () => {
    const permissions = deriveTaskRunPermissions(undefined);

    expect(permissions.sandboxMode).toBe("danger-full-access");
    expect(permissions.writeCapability).toBe("write_capable");
    expect(permissions.approvalPolicy).toBe("never");
    expect(permissions.networkAccessEnabled).toBe(true);
  });

  it("never yields the write-capable configuration for a restricted lane", () => {
    const permissions = deriveTaskRunPermissions(POLICY);

    // The two literals that make an implementer lane able to edit the
    // candidate. A restricted lane that inherited either one would be sandboxed
    // in name only.
    expect(permissions.sandboxMode).not.toBe("danger-full-access");
    expect(permissions.sandboxMode).toBe("workspace-write");
    expect(permissions.writeCapability).toBe("read_only");
  });

  it("keeps the non-write parts of the turn contract identical across roles", () => {
    // Only the write surface is role-derived: a restricted lane still runs
    // unattended, off the git-repo check, and with the same web-search stance.
    const implementer = deriveTaskRunPermissions(undefined);
    const validator = deriveTaskRunPermissions(POLICY);

    expect(validator.approvalPolicy).toBe(implementer.approvalPolicy);
    expect(validator.webSearchMode).toBe(implementer.webSearchMode);
    expect(validator.skipGitRepoCheck).toBe(implementer.skipGitRepoCheck);
    expect(validator.networkAccessEnabled).toBe(
      implementer.networkAccessEnabled,
    );
  });
});
