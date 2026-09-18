/**
 * The probe's isolated world.
 *
 * Everything Command Center reads or writes at runtime — the database, the
 * config, the transcripts, the logs — hangs off one config directory, so
 * pointing `CC_CONFIG_DIR` at a scratch tree before any CC module loads is
 * what makes a live probe safe to run beside a real installation. This module
 * therefore imports nothing from `@/` : it has to run first.
 *
 * `assertIsolated` closes the loop by checking the path the store ACTUALLY
 * resolved rather than the one we intended, which is the only version of the
 * check worth having.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The exact model a run certifies, as CC's config expresses it. */
export interface ProbeModelSelection {
  modelId: string;
  parameters: Record<string, string>;
}

export interface ProbeEnvironment {
  runId: string;
  /** Everything this run owns, under the worktree's git-ignored scratch tree. */
  root: string;
  configDir: string;
  /** A throwaway git repository standing in for the conversation's worktree. */
  projectPath: string;
  projectName: string;
  /** Where the corpus's external image reference points. */
  imageRefPath: string;
  evidenceDir: string;
  /** The pinned selection, or null when CC's own default is certified. */
  modelSelection: ProbeModelSelection | null;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * Build the scratch tree and point the process at it. Call before importing
 * any Command Center module: the config directory is resolved once at module
 * load, so a later assignment would be read by nothing.
 */
export function prepareProbeEnvironment(options: {
  tempRoot: string;
  backend: string;
  runId: string;
  imageBase64: string;
  /**
   * Pins the model for every provider call this run makes — ordinary turns
   * and compaction passes alike, which a per-turn selection could not reach.
   * Needed wherever CC's default model is one the operator's account cannot
   * address; the certified model is then named in the run's evidence rather
   * than left to a default that may differ on another machine.
   */
  modelSelection?: ProbeModelSelection | null;
}): ProbeEnvironment {
  const root = path.resolve(
    options.tempRoot,
    "checkpoint-probes",
    options.backend,
    options.runId,
  );
  rmSync(root, { recursive: true, force: true });
  const configDir = path.join(root, "config");
  const projectPath = path.join(root, "project");
  const evidenceDir = path.join(root, "evidence");
  const imagesDir = path.join(root, "images");
  for (const dir of [configDir, projectPath, evidenceDir, imagesDir]) {
    mkdirSync(dir, { recursive: true });
  }

  git(projectPath, ["init", "-q", "-b", "main"]);
  git(projectPath, ["config", "user.email", "checkpoint-probe@local"]);
  git(projectPath, ["config", "user.name", "checkpoint probe"]);
  git(projectPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(
    path.join(projectPath, "README.md"),
    "# checkpoint continuation probe scratch project\n",
    "utf-8",
  );
  git(projectPath, ["add", "-A"]);
  git(projectPath, ["commit", "-q", "-m", "probe baseline"]);

  const imageRefPath = path.join(imagesDir, "latency-chart.png");
  writeFileSync(imageRefPath, Buffer.from(options.imageBase64, "base64"));

  const modelSelection = options.modelSelection ?? null;
  // Naming is unrelated provider work and would consume the finite generation
  // ledger. Keep it disabled in every isolated probe, including default models.
  writeFileSync(
    path.join(configDir, "config.json"),
    `${JSON.stringify(
      {
        conversationNaming: { enabled: false },
        ...(modelSelection === null
          ? {}
          : { agentBackends: { [options.backend]: { modelSelection } } }),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  process.env["CC_CONFIG_DIR"] = configDir;
  // `cc-dev` would send this run at the shared dev-server state instead.
  delete process.env["CC_ENV"];

  return {
    runId: options.runId,
    root,
    configDir,
    projectPath,
    projectName: path.basename(projectPath),
    imageRefPath,
    evidenceDir,
    modelSelection,
  };
}

/**
 * Refuse to continue unless the store opened a database inside this run's
 * scratch tree. A probe that mutated the operator's real installation would
 * be indistinguishable from one that worked.
 */
export function assertIsolated(
  resolvedDbPath: string,
  environment: ProbeEnvironment,
): void {
  const resolved = path.resolve(resolvedDbPath);
  if (!resolved.startsWith(path.resolve(environment.configDir) + path.sep)) {
    throw new Error(
      `probe refused: the state store resolved ${resolved}, which is outside the scratch config dir ${environment.configDir}`,
    );
  }
}
