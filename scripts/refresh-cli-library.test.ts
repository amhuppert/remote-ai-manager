import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { refreshCliLibrary } from "./refresh-cli-library";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-cli-library-"));
  temporaryDirectories.push(directory);
  const source = path.join(directory, "source");
  const worktree = path.join(directory, "consumer");
  await mkdir(source);
  await mkdir(worktree);
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "cli-for-agents",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      scripts: { build: "node build.js" },
    }),
  );
  await writeFile(
    path.join(source, "package-lock.json"),
    JSON.stringify({
      name: "cli-for-agents",
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "cli-for-agents", version: "0.0.0" } },
    }),
  );
  await writeFile(
    path.join(source, "build.js"),
    'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist"); writeFileSync("dist/index.js", "export const version = 1;\\n");\n',
  );
  await writeFile(
    path.join(worktree, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  const git = async (...args: string[]) =>
    execFileAsync("git", args, { cwd: source });
  await git("init", "--quiet");
  await git("config", "user.name", "CLI snapshot test");
  await git("config", "user.email", "cli-snapshot@example.test");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "source");
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();
  return { source, worktree, revision, git };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI library snapshot refresh", () => {
  it("packages a selected committed revision with provenance and no producer changes", async () => {
    const { source, worktree, revision, git } = await fixture();
    await writeFile(
      path.join(source, "build.js"),
      'throw Error("newer source");\n',
    );
    await git("add", ".");
    await git("commit", "--quiet", "-m", "newer source");

    await refreshCliLibrary({ source, worktree, revision });

    const snapshot = path.join(worktree, ".yalc", "cli-for-agents");
    expect(existsSync(path.join(snapshot, "dist/index.js"))).toBe(true);
    expect(await readFile(path.join(snapshot, "dist/index.js"), "utf8")).toBe(
      "export const version = 1;\n",
    );
    const archive = await execFileAsync("git", ["archive", revision], {
      cwd: source,
      encoding: "buffer",
    });
    const provenance = JSON.parse(
      await readFile(path.join(snapshot, "cc-source.json"), "utf8"),
    );
    expect(provenance).toEqual({
      repository: "cli-for-agents",
      revision,
      archiveSha256: createHash("sha256").update(archive.stdout).digest("hex"),
    });
    const manifest = JSON.parse(
      await readFile(path.join(worktree, "package.json"), "utf8"),
    );
    expect(manifest.dependencies).toEqual({
      "cli-for-agents": "file:.yalc/cli-for-agents",
    });
    const lock = JSON.parse(
      await readFile(path.join(worktree, "yalc.lock"), "utf8"),
    );
    expect(lock.packages["cli-for-agents"].signature).toMatch(/^[a-f0-9]+$/);
    expect((await git("status", "--porcelain")).stdout).toBe("");
  }, 30_000);

  it("keeps the previous snapshot when a new revision cannot build", async () => {
    const { source, worktree, git } = await fixture();
    await refreshCliLibrary({ source, worktree });
    const snapshot = path.join(worktree, ".yalc", "cli-for-agents");
    expect(existsSync(path.join(snapshot, "yalc.sig"))).toBe(true);
    const before = await readFile(path.join(snapshot, "yalc.sig"), "utf8");
    const lockBefore = await readFile(path.join(worktree, "yalc.lock"), "utf8");
    await writeFile(
      path.join(source, "build.js"),
      'throw Error("broken build");\n',
    );
    await git("add", ".");
    await git("commit", "--quiet", "-m", "broken build");

    await expect(refreshCliLibrary({ source, worktree })).rejects.toThrow(
      "broken build",
    );

    expect(await readFile(path.join(snapshot, "yalc.sig"), "utf8")).toBe(
      before,
    );
    expect(await readFile(path.join(worktree, "yalc.lock"), "utf8")).toBe(
      lockBefore,
    );
  }, 30_000);
});
