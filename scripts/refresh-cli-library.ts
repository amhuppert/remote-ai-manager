import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const resolvePackage = createRequire(import.meta.url).resolve;
const libraryPackageSchema = z.looseObject({
  name: z.literal("cli-for-agents"),
  files: z.array(z.string()),
});

export interface RefreshCliLibraryOptions {
  source: string;
  worktree: string;
  revision?: string;
}

/** Build an immutable archive; publication never runs in the producer checkout. */
export async function refreshCliLibrary(
  options: RefreshCliLibraryOptions,
): Promise<{ revision: string; archiveSha256: string }> {
  const worktree = path.resolve(options.worktree);
  const source = path.resolve(options.source);
  const temporaryRoot = path.join(worktree, ".cc/temp");
  await mkdir(temporaryRoot, { recursive: true });
  const staging = await mkdtemp(
    path.join(temporaryRoot, "cli-library-refresh-"),
  );
  const run = async (command: string, args: string[], cwd: string) =>
    execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024 });

  try {
    const resolved = await run(
      "git",
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${options.revision ?? "HEAD"}^{commit}`,
      ],
      source,
    );
    const revision = resolved.stdout.trim();
    const archivePath = path.join(staging, "source.tar");
    await run("git", ["archive", revision, `--output=${archivePath}`], source);
    const archiveSha256 = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
    const buildDirectory = path.join(staging, "source");
    await mkdir(buildDirectory);
    await run("tar", ["-xf", archivePath, "-C", buildDirectory], worktree);
    const packagePath = path.join(buildDirectory, "package.json");
    const packageValue: unknown = JSON.parse(
      await readFile(packagePath, "utf8"),
    );
    const checkedPackage = libraryPackageSchema.safeParse(packageValue);
    if (!checkedPackage.success) {
      throw new Error(
        "The selected revision must be the cli-for-agents package with a files manifest.",
      );
    }

    await run(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(temporaryRoot, "npm-cache"),
      ],
      buildDirectory,
    );
    // This compiles the separate package using its own lockfile and build contract.
    await run("npm", ["run", "build"], buildDirectory);
    const provenance = {
      repository: "cli-for-agents",
      revision,
      archiveSha256,
    };
    await writeFile(
      path.join(buildDirectory, "cc-source.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    const packageWithProvenance = {
      ...checkedPackage.data,
      files: [...new Set([...checkedPackage.data.files, "cc-source.json"])],
    };
    await writeFile(
      packagePath,
      `${JSON.stringify(packageWithProvenance, null, 2)}\n`,
    );

    const yalc = resolvePackage("yalc/src/yalc.js");
    const store = path.join(staging, "store");
    await run(
      "node",
      [yalc, "publish", "--private", "--no-scripts", "--store-folder", store],
      buildDirectory,
    );
    await run(
      "node",
      [yalc, "add", "cli-for-agents", "--no-scripts", "--store-folder", store],
      worktree,
    );
    await run("bun", ["install"], worktree);
    return { revision, archiveSha256 };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      revision: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun run cli:library:refresh --source <checkout> [--revision <commit-ish>]",
    );
    console.log(
      "Builds committed HEAD (or the selected revision) in .cc/temp and refreshes this worktree's committed yalc snapshot and Bun lockfile. Requires git, npm, Node, and Bun. The producer checkout and other consumers are unchanged.",
    );
    return;
  }
  if (!values.source) {
    throw new Error("--source <cli-for-agents checkout> is required.");
  }
  const receipt = await refreshCliLibrary({
    source: values.source,
    worktree: process.cwd(),
    ...(values.revision ? { revision: values.revision } : {}),
  });
  console.log(
    `Refreshed cli-for-agents from ${receipt.revision} (archive SHA-256 ${receipt.archiveSha256}).`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
