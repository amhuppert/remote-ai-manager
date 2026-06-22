import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandItem } from "@/lib/commands/schemas";
import { discoverCommands } from "@/lib/commands/service";
import type { AgentBackendId } from "@/lib/shared/schemas";

import {
  createPrerequisiteProbes,
  type PrerequisiteProbesDeps,
} from "./prerequisite-probes";

function commandItem(
  name: string,
  type: CommandItem["type"] = "skill",
  source = "project",
): CommandItem {
  return {
    name,
    description: "",
    type,
    source,
  };
}

describe("createPrerequisiteProbes — probePath", () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), "prereq-probe-path-"));
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it("is satisfied for a path that exists inside the worktree", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(path.join(worktreePath, ".kiro"), { recursive: true });

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({ worktreePath, path: ".kiro" });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("is satisfied for a nested file inside the worktree", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(path.join(worktreePath, "docs"), { recursive: true });
    await writeFile(path.join(worktreePath, "docs", "guide.md"), "x");

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({
      worktreePath,
      path: "docs/guide.md",
    });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("reports 'absent' for a missing path (realpath ENOENT)", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({
      worktreePath,
      path: "does-not-exist",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("absent");
    }
  });

  it("reports 'absent' for a symlink whose real path escapes the worktree", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    // A real directory OUTSIDE the worktree, reached via an in-worktree symlink.
    const outsideDir = path.join(workRoot, "outside");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(worktreePath, "escape"));

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({ worktreePath, path: "escape" });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("absent");
    }
  });

  it("is satisfied for a symlink that resolves to a target inside the worktree", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(path.join(worktreePath, "real"), { recursive: true });
    await symlink(
      path.join(worktreePath, "real"),
      path.join(worktreePath, "link"),
    );

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({ worktreePath, path: "link" });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("reports 'probe_error' for a non-ENOENT fs error (parent component is a file → ENOTDIR)", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    // `notdir` is a FILE; resolving `notdir/child` produces ENOTDIR, not ENOENT.
    await writeFile(path.join(worktreePath, "notdir"), "x");

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probePath({
      worktreePath,
      path: "notdir/child",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("probe_error");
    }
  });

  it("reports 'probe_error' and never satisfied when the realpath primitive throws a non-ENOENT error", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const eacces: NodeJS.ErrnoException = new Error("permission denied");
    eacces.code = "EACCES";

    const deps: PrerequisiteProbesDeps = {
      realpath: async () => {
        throw eacces;
      },
    };
    const probes = createPrerequisiteProbes(deps);
    const outcome = await probes.probePath({
      worktreePath,
      path: ".kiro",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("probe_error");
    }
  });
});

describe("createPrerequisiteProbes — probeSkill", () => {
  function probesWithItems(
    itemsByBackend: Partial<Record<AgentBackendId, CommandItem[]>>,
  ): ReturnType<typeof createPrerequisiteProbes> {
    const calls: Array<{ worktreePath: string; backend: AgentBackendId }> = [];
    const deps: PrerequisiteProbesDeps = {
      discover: async (worktreePath, backend) => {
        calls.push({ worktreePath, backend });
        return itemsByBackend[backend] ?? [];
      },
    };
    return createPrerequisiteProbes(deps);
  }

  it("is satisfied when a skill item matches the normalized reference", async () => {
    const probes = probesWithItems({
      claude: [commandItem("/kiro-spec-design", "skill")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "kiro-spec-design",
      backend: "claude",
    });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("treats kiro-spec-design, /kiro-spec-design and $kiro-spec-design as the same reference", async () => {
    const probes = probesWithItems({
      claude: [commandItem("$kiro-spec-design", "skill")],
    });

    for (const declared of [
      "kiro-spec-design",
      "/kiro-spec-design",
      "$kiro-spec-design",
    ]) {
      const outcome = await probes.probeSkill({
        worktreePath: "/wt",
        skill: declared,
        backend: "claude",
      });
      expect(outcome).toEqual({ satisfied: true });
    }
  });

  it("does NOT treat kiro:spec-init and kiro-spec-init as the same reference", async () => {
    const probes = probesWithItems({
      claude: [commandItem("kiro-spec-init", "skill")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "kiro:spec-init",
      backend: "claude",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("absent");
    }
  });

  it("matches a slash-command item (type: 'command') with the same normalized reference", async () => {
    const probes = probesWithItems({
      claude: [commandItem("/kiro-spec-design", "command")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "kiro-spec-design",
      backend: "claude",
    });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("matches a Codex built-in skill surfaced as a .system-origin item (no filtering by source)", async () => {
    const probes = probesWithItems({
      codex: [commandItem("$builtin-skill", "skill", "system")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "builtin-skill",
      backend: "codex",
    });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("matches regardless of any enabled/disabled state — the probe only sees discovered names", async () => {
    // discoverCommands returns items irrespective of dynamic enabled/disabled
    // state; the probe must match a returned item even though it carries no
    // enabled flag. Presence in the discovery result IS the match condition.
    const probes = probesWithItems({
      claude: [commandItem("some-skill", "skill")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "some-skill",
      backend: "claude",
    });

    expect(outcome).toEqual({ satisfied: true });
  });

  it("does NOT find a skill present only on a different backend's roots (backend isolation)", async () => {
    const probes = probesWithItems({
      claude: [commandItem("claude-only-skill", "skill")],
      codex: [commandItem("codex-only-skill", "skill")],
    });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "claude-only-skill",
      backend: "codex",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("absent");
    }
  });

  it("queries discovery with exactly the requested backend", async () => {
    const calls: Array<{ worktreePath: string; backend: AgentBackendId }> = [];
    const deps: PrerequisiteProbesDeps = {
      discover: async (worktreePath, backend) => {
        calls.push({ worktreePath, backend });
        return [];
      },
    };
    const probes = createPrerequisiteProbes(deps);

    await probes.probeSkill({
      worktreePath: "/wt",
      skill: "x",
      backend: "codex",
    });

    expect(calls).toEqual([{ worktreePath: "/wt", backend: "codex" }]);
  });

  it("reports 'absent' when no item matches", async () => {
    const probes = probesWithItems({ claude: [commandItem("other")] });

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "missing",
      backend: "claude",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("absent");
    }
  });

  it("reports 'probe_error' (never satisfied) when discovery throws", async () => {
    const deps: PrerequisiteProbesDeps = {
      discover: async () => {
        throw new Error("discovery blew up");
      },
    };
    const probes = createPrerequisiteProbes(deps);

    const outcome = await probes.probeSkill({
      worktreePath: "/wt",
      skill: "x",
      backend: "claude",
    });

    expect(outcome.satisfied).toBe(false);
    if (!outcome.satisfied) {
      expect(outcome.reason).toBe("probe_error");
    }
  });
});

describe("createPrerequisiteProbes — production wiring", () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), "prereq-probe-wire-"));
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it("binds the real discoverCommands by default (finds a real .claude/skills entry)", async () => {
    const worktreePath = path.join(workRoot, "worktree");
    const skillDir = path.join(worktreePath, ".claude", "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: A demo skill.\n---\nbody\n",
    );

    // Cross-check: the real service surfaces this skill, and the no-deps probe
    // must agree (proving the default binding is the real discoverCommands).
    const discovered = await discoverCommands(worktreePath, "claude");
    expect(discovered.some((item) => item.name.includes("demo-skill"))).toBe(
      true,
    );

    const probes = createPrerequisiteProbes();
    const outcome = await probes.probeSkill({
      worktreePath,
      skill: "demo-skill",
      backend: "claude",
    });

    expect(outcome).toEqual({ satisfied: true });
  });
});
