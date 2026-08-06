/**
 * Backend-neutral hygiene for an {@link FsWritePolicy} before a backend adapter
 * translates it onto a native sandbox.
 *
 * Every adapter that claims `fsWriteRestriction: "enforced"` has to answer the
 * same question first: is this policy something the OS can be asked to enforce
 * *as written*? The checks here are the cases where the answer is no and the
 * only safe reply is to refuse the run:
 *
 *  - an empty allowlist would leave a lane with no writable path at all, and
 *    every backend's natural fallback for that is to widen something (a
 *    writable cwd, an ambient temp dir);
 *  - a relative entry is resolved against a working directory the composer did
 *    not choose, so what it permits is unknowable from here;
 *  - an entry inside — or equal to — a denied path is a policy that both
 *    permits and forbids the same subtree, and picking a winner is exactly the
 *    guess the envelope exists to eliminate.
 *
 * The result is a value, not a throw: the adapters turn it into a failed task
 * result so establishment failure reaches the caller as an infrastructure
 * outcome rather than as an exception some intermediate layer might swallow.
 */

import path from "node:path";
import type { FsWritePolicy } from "./task";

export type FsWritePolicyCheck =
  | { kind: "ok" }
  | { kind: "unestablishable"; reason: string };

function isInsideOrEqual(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function checkFsWritePolicy(policy: FsWritePolicy): FsWritePolicyCheck {
  if (policy.allowWrite.length === 0) {
    return {
      kind: "unestablishable",
      reason: "the write policy allows no path at all",
    };
  }

  for (const entry of [...policy.allowWrite, ...policy.denyWrite]) {
    if (!path.isAbsolute(entry)) {
      return {
        kind: "unestablishable",
        reason: `the write policy entry "${entry}" is not an absolute path`,
      };
    }
  }

  for (const allowed of policy.allowWrite) {
    for (const denied of policy.denyWrite) {
      if (isInsideOrEqual(denied, allowed)) {
        return {
          kind: "unestablishable",
          reason: `the write policy allows "${allowed}", which is inside the denied path "${denied}"`,
        };
      }
    }
  }

  return { kind: "ok" };
}
