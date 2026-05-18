import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_SKILL_DISCOVERY_PATHS,
  discoverCodexPlugins,
  discoverCodexSkills,
} from "./codex-discovery";

let workTree: string;
let home: string;

async function writeSkill(
  dir: string,
  skillId: string,
  body: string,
): Promise<void> {
  await mkdir(path.join(dir, skillId), { recursive: true });
  await writeFile(
    path.join(dir, skillId, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${body}\n---\n${body}\n`,
    "utf-8",
  );
}

beforeEach(async () => {
  workTree = await mkdtemp(path.join(os.tmpdir(), "codex-disc-work-"));
  home = await mkdtemp(path.join(os.tmpdir(), "codex-disc-home-"));
});

afterEach(async () => {
  await rm(workTree, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("Codex skill discovery", () => {
  it("declares the design-authoritative source list", () => {
    // The design spec names these concrete locations; the discovery must not
    // silently swap them for a different layout without updating both.
    expect(CODEX_SKILL_DISCOVERY_PATHS).toEqual([
      { layer: "project", relative: ".agents/skills", source: "project" },
      { layer: "project", relative: ".codex/skills", source: "project" },
      { layer: "user", relative: ".agents/skills", source: "user" },
      { layer: "user", relative: ".codex/skills", source: "user" },
      { layer: "system", relative: ".codex/skills/.system", source: "system" },
    ]);
  });

  it("returns an empty inventory with no diagnostics when no skill sources exist", async () => {
    const result = await discoverCodexSkills({ worktreePath: workTree, home });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.sourceSignature).toBeTypeOf("string");
  });

  it("discovers skills from every declared source layer", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "project a");
    await writeSkill(path.join(workTree, ".codex/skills"), "p2", "project b");
    await writeSkill(path.join(home, ".agents/skills"), "u1", "user a");
    await writeSkill(path.join(home, ".codex/skills"), "u2", "user b");
    await writeSkill(
      path.join(home, ".codex/skills/.system"),
      "s1",
      "system a",
    );

    const result = await discoverCodexSkills({ worktreePath: workTree, home });

    const idsBySource = new Map<string, string[]>();
    for (const item of result.items) {
      const list = idsBySource.get(item.source) ?? [];
      list.push(item.itemId);
      idsBySource.set(item.source, list);
    }

    expect(idsBySource.get("project")?.sort()).toEqual(["p1", "p2"]);
    expect(idsBySource.get("user")?.sort()).toEqual(["u1", "u2"]);
    expect(idsBySource.get("system")).toEqual(["s1"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not double-count user-level discovery when scanning home .codex/skills (excludes the .system subdir)", async () => {
    await writeSkill(
      path.join(home, ".codex/skills/.system"),
      "sys-only",
      "system",
    );
    const result = await discoverCodexSkills({ worktreePath: workTree, home });
    const matches = result.items.filter((item) => item.itemId === "sys-only");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe("system");
  });

  it("produces a stable source signature that changes when a new skill is added", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "before");
    const first = await discoverCodexSkills({ worktreePath: workTree, home });

    await writeSkill(path.join(workTree, ".agents/skills"), "p2", "added");
    const second = await discoverCodexSkills({ worktreePath: workTree, home });

    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("changes the source signature when an existing skill's content changes (not just when items appear/disappear)", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "before");
    const first = await discoverCodexSkills({ worktreePath: workTree, home });

    // Same itemId, different SKILL.md body → discovered description changes,
    // so the signature must change. This protects against cache staleness
    // after a user edits a skill in place.
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "after");
    const second = await discoverCodexSkills({ worktreePath: workTree, home });

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.itemId).toBe("p1");
    expect(second.items[0]?.itemId).toBe("p1");
    expect(first.items[0]?.description).not.toBe(second.items[0]?.description);
    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("returns a diagnostic when a skill source path is unreadable", async () => {
    const unreadableSourceDir = path.join(workTree, ".agents/skills");
    await mkdir(unreadableSourceDir, { recursive: true });
    await writeFile(
      path.join(unreadableSourceDir, "broken-SKILL.md"),
      "not a directory",
      "utf-8",
    );

    // No real malformed-FS error to provoke without root; instead, verify that
    // discovery treats an unreadable subdir gracefully when injected via a
    // simulated readDir error through the dependency injection seam.
    const result = await discoverCodexSkills({
      worktreePath: workTree,
      home,
      readDir: async () => {
        throw new Error("EACCES: simulated permission denied");
      },
    });

    expect(result.items).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.message).toContain("EACCES");
  });
});

describe("Codex plugin discovery", () => {
  it("returns an unavailable diagnostic instead of pretending to discover plugins", async () => {
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toEqual([]);
    expect(result.discoverySupport).toBe("unavailable-pending-verification");
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe("codex-plugins-unavailable");
    expect(diagnostic?.severity).toBe("warning");
  });
});
