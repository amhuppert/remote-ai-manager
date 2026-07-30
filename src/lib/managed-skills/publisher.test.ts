import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { publishManagedSkillBundle } from "./publisher";

async function writeSourcePlugin(
  root: string,
  options?: { version?: string; skillBody?: string },
): Promise<void> {
  const version = options?.version ?? "2.22.0";
  const skillBody =
    options?.skillBody ?? "---\ndescription: Test skill\n---\n\nBody.";
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "command-center", version }),
  );
  for (const skill of ["agent-context", "cc-cli"]) {
    await mkdir(path.join(root, "skills", skill), { recursive: true });
    await writeFile(path.join(root, "skills", skill, "SKILL.md"), skillBody);
  }
}

describe("publishManagedSkillBundle", () => {
  let tempDir: string;
  let sourceDir: string;
  let configDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-managed-skills-"));
    sourceDir = path.join(tempDir, "source");
    configDir = path.join(tempDir, "config");
    await mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("publishes a valid plugin source to a content-addressed bundle dir", async () => {
    await writeSourcePlugin(sourceDir);

    const result = await publishManagedSkillBundle({ sourceDir, configDir });

    expect(result.published).toBe(true);
    if (!result.published) return;
    expect(result.alreadyPublished).toBe(false);
    expect(result.bundle.id).toBe("command-center");
    expect(result.bundle.version).toBe("2.22.0");
    expect(result.bundle.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.bundle.root).toBe(
      path.join(
        configDir,
        "agent-bundles",
        "command-center",
        result.bundle.digest,
      ),
    );
    expect(result.bundle.skillsRoot).toBe(
      path.join(result.bundle.root, "skills"),
    );
    expect(result.bundle.skillNames).toEqual(["agent-context", "cc-cli"]);

    // Published copy is complete: manifest + skills present on disk.
    const publishedManifest = JSON.parse(
      await readFile(
        path.join(result.bundle.root, ".claude-plugin", "plugin.json"),
        "utf-8",
      ),
    ) as { name: string };
    expect(publishedManifest.name).toBe("command-center");
    expect(
      existsSync(path.join(result.bundle.skillsRoot, "cc-cli", "SKILL.md")),
    ).toBe(true);
    // No temp litter next to the published dir.
    const siblings = await readdir(
      path.join(configDir, "agent-bundles", "command-center"),
    );
    expect(siblings).toEqual([result.bundle.digest]);
  });

  it("is idempotent: republishing identical content reuses the bundle", async () => {
    await writeSourcePlugin(sourceDir);

    const first = await publishManagedSkillBundle({ sourceDir, configDir });
    const second = await publishManagedSkillBundle({ sourceDir, configDir });

    expect(first.published).toBe(true);
    expect(second.published).toBe(true);
    if (!first.published || !second.published) return;
    expect(second.alreadyPublished).toBe(true);
    expect(second.bundle.digest).toBe(first.bundle.digest);
    expect(second.bundle.root).toBe(first.bundle.root);
  });

  it("publishes edited content to a new digest and keeps the old bundle immutable", async () => {
    await writeSourcePlugin(sourceDir);
    const first = await publishManagedSkillBundle({ sourceDir, configDir });

    await writeFile(
      path.join(sourceDir, "skills", "cc-cli", "SKILL.md"),
      "---\ndescription: Edited skill\n---\n\nNew body.",
    );
    const second = await publishManagedSkillBundle({ sourceDir, configDir });

    expect(first.published && second.published).toBe(true);
    if (!first.published || !second.published) return;
    expect(second.bundle.digest).not.toBe(first.bundle.digest);
    // The old published copy still holds the original content.
    const oldContent = await readFile(
      path.join(first.bundle.skillsRoot, "cc-cli", "SKILL.md"),
      "utf-8",
    );
    expect(oldContent).toContain("Test skill");
  });

  it("rejects a source whose plugin manifest is missing", async () => {
    await writeSourcePlugin(sourceDir);
    await rm(path.join(sourceDir, ".claude-plugin"), { recursive: true });

    const result = await publishManagedSkillBundle({ sourceDir, configDir });

    expect(result).toEqual({ published: false, reason: "invalid_bundle" });
  });

  it("rejects a source containing a skill directory without SKILL.md", async () => {
    await writeSourcePlugin(sourceDir);
    await mkdir(path.join(sourceDir, "skills", "broken"), { recursive: true });

    const result = await publishManagedSkillBundle({ sourceDir, configDir });

    expect(result).toEqual({ published: false, reason: "invalid_bundle" });
  });

  it("reports a missing source directory", async () => {
    const result = await publishManagedSkillBundle({
      sourceDir: path.join(tempDir, "does-not-exist"),
      configDir,
    });

    expect(result).toEqual({ published: false, reason: "source_missing" });
  });
});
