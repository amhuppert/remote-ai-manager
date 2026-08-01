import { afterEach, describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseFrontmatter, discoverCommands } from "./service";

describe("parseFrontmatter", () => {
  it("parses valid frontmatter block", () => {
    const content = `---
description: Initialize a spec
argument-hint: <project-description>
---
Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("Initialize a spec");
    expect(result.fields["argument-hint"]).toBe("<project-description>");
    expect(result.body).toBe("Body content here.");
  });

  it("returns empty fields when no frontmatter", () => {
    const content = "Just body content.";
    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Just body content.");
  });

  it("handles empty content", () => {
    const result = parseFrontmatter("");
    expect(result.fields).toEqual({});
    expect(result.body).toBe("");
  });

  it("handles frontmatter with no closing delimiter", () => {
    const content = `---
description: No closing`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe(content);
  });

  it("strips surrounding quotes from values", () => {
    const content = `---
description: "A quoted value"
name: 'single quoted'
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("A quoted value");
    expect(result.fields["name"]).toBe("single quoted");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
Body only.`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Body only.");
  });
});

describe("discoverCommands", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      cleanupPaths
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("discovers Codex-visible skills from project, user, and system roots", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    await mkdir(path.join(worktreePath, ".agents", "skills", "project-skill"), {
      recursive: true,
    });
    await writeFile(
      path.join(worktreePath, ".agents", "skills", "project-skill", "SKILL.md"),
      `---
name: project-skill
description: Project codex skill
---
Project skill body.`,
    );

    await mkdir(path.join(homeDir, ".agents", "skills", "user-skill"), {
      recursive: true,
    });
    await writeFile(
      path.join(homeDir, ".agents", "skills", "user-skill", "SKILL.md"),
      `---
name: user-skill
description: User codex skill
---
User skill body.`,
    );

    await mkdir(
      path.join(homeDir, ".codex", "skills", ".system", "system-skill"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        homeDir,
        ".codex",
        "skills",
        ".system",
        "system-skill",
        "SKILL.md",
      ),
      `---
name: system-skill
description: System codex skill
---
System skill body.`,
    );

    await mkdir(path.join(worktreePath, ".claude", "skills", "claude-only"), {
      recursive: true,
    });
    await writeFile(
      path.join(worktreePath, ".claude", "skills", "claude-only", "SKILL.md"),
      `---
description: Should not appear for codex
---
Claude skill body.`,
    );

    const items = await (
      discoverCommands as unknown as (
        worktreePath: string,
        backend: string,
      ) => Promise<Array<{ name: string; source: string }>>
    )(worktreePath, "codex");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "$project-skill", source: "project" }),
        expect.objectContaining({ name: "$user-skill", source: "user" }),
        expect.objectContaining({ name: "$system-skill", source: "system" }),
      ]),
    );
    expect(items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/claude-only" }),
      ]),
    );
  });

  it("preserves the managed bundle namespace for nested Codex skills", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    const bundlePath = await mkdtemp(path.join(tmpdir(), "commands-bundle-"));
    cleanupPaths.push(homeDir, worktreePath, bundlePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    for (const skillName of ["agent-context", "cc-cli"]) {
      const skillPath = path.join(bundlePath, "skills", skillName);
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, "SKILL.md"),
        `---\ndescription: ${skillName} managed skill\n---\nBody.`,
      );
    }
    const projectSkillsPath = path.join(worktreePath, ".agents", "skills");
    await mkdir(projectSkillsPath, { recursive: true });
    await symlink(
      path.join(bundlePath, "skills"),
      path.join(projectSkillsPath, "command-center"),
      "dir",
    );
    const flatCcCliPath = path.join(projectSkillsPath, "cc-cli");
    await mkdir(flatCcCliPath, { recursive: true });
    await writeFile(
      path.join(flatCcCliPath, "SKILL.md"),
      "---\ndescription: Project-local cc-cli\n---\nBody.",
    );
    const nestedSkillPath = path.join(
      projectSkillsPath,
      "ordinary-container",
      "nested-skill",
    );
    await mkdir(nestedSkillPath, { recursive: true });
    await writeFile(
      path.join(nestedSkillPath, "SKILL.md"),
      "---\ndescription: Ordinary nested skill\n---\nBody.",
    );
    const flatSkillPath = path.join(bundlePath, "flat-target");
    await mkdir(flatSkillPath, { recursive: true });
    await writeFile(
      path.join(flatSkillPath, "SKILL.md"),
      "---\ndescription: Flat linked skill\n---\nBody.",
    );
    await symlink(
      flatSkillPath,
      path.join(projectSkillsPath, "flat-link"),
      "dir",
    );

    const items = await discoverCommands(worktreePath, "codex");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "$command-center:agent-context",
          source: "project",
        }),
        expect.objectContaining({
          name: "$command-center:cc-cli",
          source: "project",
        }),
        expect.objectContaining({ name: "$flat-link", source: "project" }),
        expect.objectContaining({ name: "$cc-cli", source: "project" }),
        expect.objectContaining({ name: "$nested-skill", source: "project" }),
      ]),
    );
    expect(items.map((item) => item.name)).not.toContain(
      "$ordinary-container:nested-skill",
    );
  });

  it("uses directory basename for skill id, ignoring frontmatter name with spaces", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    await mkdir(
      path.join(worktreePath, ".claude", "skills", "expo-ui-swift-ui"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        worktreePath,
        ".claude",
        "skills",
        "expo-ui-swift-ui",
        "SKILL.md",
      ),
      `---
name: Expo UI SwiftUI
description: A display name with spaces
---
Body.`,
    );

    const items = await (
      discoverCommands as unknown as (
        worktreePath: string,
        backend: string,
      ) => Promise<Array<{ name: string; source: string }>>
    )(worktreePath, "claude");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/expo-ui-swift-ui" }),
      ]),
    );
    expect(items.every((item) => !item.name.includes(" "))).toBe(true);
  });

  it("discovers a Claude skill installed as a symlink in ~/.claude/skills", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "commands-home-"));
    const worktreePath = await mkdtemp(
      path.join(tmpdir(), "commands-worktree-"),
    );
    cleanupPaths.push(homeDir, worktreePath);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const realSkillDir = path.join(homeDir, ".agents", "skills", "find-skills");
    await mkdir(realSkillDir, { recursive: true });
    await writeFile(
      path.join(realSkillDir, "SKILL.md"),
      `---
name: find-skills
description: Discover and install agent skills
---
Body.`,
    );

    const linkDir = path.join(homeDir, ".claude", "skills");
    await mkdir(linkDir, { recursive: true });
    await symlink(realSkillDir, path.join(linkDir, "find-skills"), "dir");

    const items = await (
      discoverCommands as unknown as (
        worktreePath: string,
        backend: string,
      ) => Promise<Array<{ name: string; source: string }>>
    )(worktreePath, "claude");

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/find-skills", source: "user" }),
      ]),
    );
  });
});
