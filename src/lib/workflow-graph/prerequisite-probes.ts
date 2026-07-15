import { realpath as nodeRealpath } from "node:fs/promises";
import path from "node:path";

import type { CommandItem } from "@/lib/commands/schemas";
import { discoverCommands } from "@/lib/commands/service";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { normalizeSkillReference } from "@/lib/workflow-graph/definition-schemas";

const logger = createLogger("workflow-graph.prerequisite-probes");

// Result of a single deterministic prerequisite probe. "absent" = definitively
// not present (the normal missing case: realpath not-found, a worktree-escaping
// symlink, or no discovered skill matches). "probe_error" = the probe could not
// evaluate (a non-ENOENT fs error or a skill-discovery failure). A probe is
// NEVER reported satisfied on error — both unsatisfied arms fail closed (R5.10).
export type ProbeOutcome =
  | { satisfied: true }
  | { satisfied: false; reason: "absent" | "probe_error"; detail?: string };

export interface PrerequisiteProbes {
  // Resolves the worktree-relative path via realpath and confirms the real path
  // is contained within worktreePath. Not-found and a worktree-escaping symlink
  // → { satisfied:false, reason:"absent" }; any other fs error →
  // { satisfied:false, reason:"probe_error" } (R5.3, R5.10). Inputs reaching
  // here are already accept-time-validated worktree-relative with no ".."
  // segment (R4.8); the realpath containment is the runtime second line of
  // defence against a symlink escape (R5.3). Report-only — never creates or
  // modifies anything.
  probePath(input: {
    worktreePath: string;
    path: string;
  }): Promise<ProbeOutcome>;
  // A skill prerequisite is satisfied iff some discovered item (skill OR
  // slash-command) for `backend` has a normalized name equal to the normalized
  // declared reference, by REUSING the runtime skill-discovery service so the
  // roots mirror the run exactly (including the Codex `.system` built-in root).
  // Independent of dynamic enabled/disabled state. A discovery throw →
  // { satisfied:false, reason:"probe_error" }, never satisfied (R5.4, R5.10).
  probeSkill(input: {
    worktreePath: string;
    skill: string;
    backend: AgentBackendId;
  }): Promise<ProbeOutcome>;
}

// Method syntax (bivariant) so production functions assign cleanly to these
// slots without contravariance friction.
export interface PrerequisiteProbesDeps {
  // Defaults to node:fs/promises realpath. Injected so the path probe runs over
  // real temp-dir fixtures in tests while forced fs errors stay controllable.
  realpath?(target: string): Promise<string>;
  // Defaults to the real discoverCommands so production mirrors the actual run.
  // Injected so skill-probe logic tests feed crafted CommandItem[] without
  // mocking the internal commands service module.
  discover?(
    worktreePath: string,
    backend: AgentBackendId,
  ): Promise<CommandItem[]>;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  // A descendant yields a relative path that neither escapes upward (no leading
  // "..") nor is absolute (different drive/root on Windows).
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function createPrerequisiteProbes(
  deps: PrerequisiteProbesDeps = {},
): PrerequisiteProbes {
  const realpath = deps.realpath ?? nodeRealpath;
  const discover = deps.discover ?? discoverCommands;

  return {
    async probePath({ worktreePath, path: declaredPath }) {
      let realRoot: string;
      try {
        realRoot = await realpath(worktreePath);
      } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
          // A missing worktree root means the declared path cannot exist there.
          return { satisfied: false, reason: "absent" };
        }
        logger.warn("probe.path.root_error", {
          worktreePath,
          path: declaredPath,
          error: getErrorMessage(err),
        });
        return { satisfied: false, reason: "probe_error" };
      }

      const joined = path.join(realRoot, declaredPath);
      let realTarget: string;
      try {
        realTarget = await realpath(joined);
      } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
          return { satisfied: false, reason: "absent" };
        }
        logger.warn("probe.path.error", {
          worktreePath,
          path: declaredPath,
          error: getErrorMessage(err),
        });
        return { satisfied: false, reason: "probe_error" };
      }

      if (!isContained(realRoot, realTarget)) {
        // A symlink whose real path escapes the worktree is treated as the
        // normal unmet case, never satisfied (R5.3).
        return { satisfied: false, reason: "absent" };
      }
      return { satisfied: true };
    },

    async probeSkill({ worktreePath, skill, backend }) {
      let items: CommandItem[];
      try {
        items = await discover(worktreePath, backend);
      } catch (err) {
        logger.warn("probe.skill.error", {
          worktreePath,
          backend,
          skill,
          error: getErrorMessage(err),
        });
        return { satisfied: false, reason: "probe_error" };
      }

      const target = normalizeSkillReference(skill);
      const found = items.some(
        (item) => normalizeSkillReference(item.name) === target,
      );
      return found
        ? { satisfied: true }
        : { satisfied: false, reason: "absent" };
    },
  };
}
