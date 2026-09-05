import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ManagedSkillBundle } from "@/lib/managed-skills/schemas";
import { publishManagedSkillBundle } from "@/lib/managed-skills/publisher";
import { setPublishedManagedSkillBundle } from "@/lib/managed-skills/service";

import {
  ensureCodexManagedSkillsBridge,
  MANAGED_SKILLS_EXCLUDE_PATTERN,
  MANAGED_SKILLS_LINK_RELATIVE,
} from "./managed-skills-bridge";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@test.local"]);
  await git(dir, ["config", "user.name", "Test"]);
}

async function writeBundleOnDisk(
  bundlesArea: string,
  digest: string,
): Promise<ManagedSkillBundle> {
  const root = path.join(
    bundlesArea,
    "agent-bundles",
    "command-center",
    digest,
  );
  const skillsRoot = path.join(root, "skills");
  for (const skill of ["agent-context", "cc-cli"]) {
    await mkdir(path.join(skillsRoot, skill), { recursive: true });
    await writeFile(
      path.join(skillsRoot, skill, "SKILL.md"),
      `---\ndescription: ${skill}\n---\n\nBody (${digest}).`,
    );
  }
  return {
    id: "command-center",
    version: "2.22.0",
    digest,
    root,
    skillsRoot,
    skillNames: ["agent-context", "cc-cli"],
  };
}

describe("reserved managed-skills path", () => {
  it("resolves to the namespaced Codex skill root", () => {
    expect(MANAGED_SKILLS_LINK_RELATIVE).toBe(
      path.join(".agents", "skills", "command-center"),
    );
    expect(MANAGED_SKILLS_EXCLUDE_PATTERN).toBe(
      `/${MANAGED_SKILLS_LINK_RELATIVE}`,
    );
  });

  // Turbopack statically evaluates an all-literal path.join and emits a
  // DirAssetReference for the result. This module is reachable from the
  // instrumentation entrypoint, so that reference makes the bundler walk the
  // very directory the bridge fills with a symlink out of the checkout — and
  // Turbopack panics fatally on a symlink that leaves the project root,
  // breaking `bun run build` in every checkout an agent has launched in.
  it("never hands the bundler a statically resolvable directory literal", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "managed-skills-bridge.ts"),
      "utf8",
    );
    const allLiteralJoins = [
      ...source.matchAll(/path\.join\(([^()]*)\)/g),
    ].filter((match) =>
      (match[1] ?? "")
        .split(",")
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0)
        .every((arg) => /^"[^"]*"$/.test(arg)),
    );

    expect(allLiteralJoins.map(([call]) => call)).toEqual([]);
  });
});

describe("ensureCodexManagedSkillsBridge", () => {
  let tempDir: string;
  let checkout: string;
  let bundle: ManagedSkillBundle;

  const linkPath = () =>
    path.join(checkout, ".agents", "skills", "command-center");

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-skills-bridge-"));
    checkout = path.join(tempDir, "checkout");
    await mkdir(checkout, { recursive: true });
    await initGitRepo(checkout);
    bundle = await writeBundleOnDisk(
      path.join(tempDir, "config"),
      "aaaa000000000001",
    );
    setPublishedManagedSkillBundle(bundle);
  });

  afterEach(async () => {
    setPublishedManagedSkillBundle(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the namespaced link and keeps git status clean", async () => {
    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle,
    });

    expect(result.status).toBe("linked");
    expect(await readlink(linkPath())).toBe(bundle.skillsRoot);
    // The skill content resolves through the link.
    expect(existsSync(path.join(linkPath(), "cc-cli", "SKILL.md"))).toBe(true);
    // Exclusion holds: nothing shows in status and add -A stages nothing.
    expect((await git(checkout, ["status", "--porcelain"])).trim()).toBe("");
    await git(checkout, ["add", "-A"]);
    expect(
      (await git(checkout, ["diff", "--cached", "--name-only"])).trim(),
    ).toBe("");
  });

  it("loads the published planning packages in a project without local skill copies", async () => {
    const sourceDir = path.join(
      process.cwd(),
      "plugins/command-center/command-center",
    );
    const published = await publishManagedSkillBundle({
      sourceDir,
      configDir: path.join(tempDir, "published-config"),
    });
    expect(published.published).toBe(true);
    if (!published.published) return;

    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle: published.bundle,
    });
    expect(result.status).toBe("linked");

    for (const name of ["graph-workflow-planning", "graph-workflow-review"]) {
      const source = path.join(sourceDir, "skills", name);
      const files = ["SKILL.md", "agents/openai.yaml"];
      if (existsSync(path.join(source, "references"))) {
        files.push(
          ...(await readdir(path.join(source, "references"))).map(
            (file) => `references/${file}`,
          ),
        );
      }
      expect(published.bundle.skillNames).toContain(name);
      for (const file of files) {
        expect(await readFile(path.join(linkPath(), name, file), "utf8")).toBe(
          await readFile(path.join(source, file), "utf8"),
        );
      }
      for (const root of [".agents/skills", ".claude/skills"]) {
        expect(existsSync(path.join(checkout, root, name))).toBe(false);
      }
    }
    expect((await git(checkout, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("is idempotent when the expected link already exists", async () => {
    await ensureCodexManagedSkillsBridge({ checkoutPath: checkout, bundle });
    const second = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle,
    });

    expect(second.status).toBe("already_linked");
    expect(await readlink(linkPath())).toBe(bundle.skillsRoot);
  });

  it("re-points a CC-owned link left by an older bundle digest", async () => {
    const oldBundle = await writeBundleOnDisk(
      path.join(tempDir, "config"),
      "bbbb000000000002",
    );
    await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle: oldBundle,
    });

    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle,
    });

    expect(result.status).toBe("linked");
    expect(await readlink(linkPath())).toBe(bundle.skillsRoot);
  });

  it("never overwrites project-owned content at the reserved path", async () => {
    await mkdir(linkPath(), { recursive: true });
    await writeFile(path.join(linkPath(), "SKILL.md"), "project-owned");

    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle,
    });

    expect(result.status).toBe("conflict");
    expect((await lstat(linkPath())).isDirectory()).toBe(true);
    expect(existsSync(path.join(linkPath(), "SKILL.md"))).toBe(true);
  });

  it("treats a foreign symlink at the reserved path as a conflict", async () => {
    const foreignTarget = path.join(tempDir, "somewhere-else");
    await mkdir(foreignTarget, { recursive: true });
    await mkdir(path.dirname(linkPath()), { recursive: true });
    await symlink(foreignTarget, linkPath());

    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle,
    });

    expect(result.status).toBe("conflict");
    expect(await readlink(linkPath())).toBe(foreignTarget);
  });

  it("skips without touching the filesystem when the checkout is not a git repo", async () => {
    const bareDir = path.join(tempDir, "not-a-repo");
    await mkdir(bareDir, { recursive: true });

    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: bareDir,
      bundle,
    });

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("exclude_unavailable");
    expect(existsSync(path.join(bareDir, ".agents"))).toBe(false);
  });

  it("skips when no bundle is published", async () => {
    const result = await ensureCodexManagedSkillsBridge({
      checkoutPath: checkout,
      bundle: null,
    });

    expect(result).toEqual({ status: "skipped", reason: "no_bundle" });
    expect(existsSync(path.join(checkout, ".agents"))).toBe(false);
  });
});
