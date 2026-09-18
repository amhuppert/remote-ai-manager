import { realpathSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export function assertScratchChild(candidate: string, scratch: string): void {
  if (!path.resolve(candidate).startsWith(path.resolve(scratch) + path.sep))
    throw new Error(
      "artifact replay path must stay inside this worktree's checkpoint scratch tree",
    );
}

const priorRunSchema = z.object({
  environment: z.object({
    runId: z.string(),
    root: z.string(),
    configDir: z.string(),
    projectPath: z.string(),
    projectName: z.string(),
    imageRefPath: z.string(),
    evidenceDir: z.string(),
    modelSelection: z
      .object({
        modelId: z.string(),
        parameters: z.record(z.string(), z.string()),
      })
      .nullable(),
  }),
  args: z.object({
    backend: z.enum(["claude", "codex"]),
    scope: z.enum(["session", "project"]),
    scenario: z.literal("cycles"),
  }),
  result: z.object({
    conversationId: z.string(),
    transcriptPath: z.string(),
    cycles: z
      .array(z.object({ operationId: z.string(), seedSha256: z.string() }))
      .min(1),
  }),
});

/** Resolve every existing path, so a symlink cannot redirect writes into live state. */
export function loadArtifactEnvironment(input: {
  fromRun: string;
  runId: string;
  backend: "claude" | "codex";
  scope: "session" | "project";
}) {
  const scratch = realpathSync(path.resolve(".cc/temp/checkpoint-probes"));
  const evidencePath = realpathSync(input.fromRun);
  assertScratchChild(evidencePath, scratch);
  const prior = priorRunSchema.parse(
    JSON.parse(readFileSync(evidencePath, "utf-8")),
  );
  if (prior.args.backend !== input.backend || prior.args.scope !== input.scope)
    throw new Error("artifact run backend/scope must match the saved run");
  for (const candidate of [
    prior.environment.root,
    prior.environment.configDir,
    prior.environment.projectPath,
    prior.environment.evidenceDir,
    prior.environment.imageRefPath,
    prior.result.transcriptPath,
  ])
    assertScratchChild(realpathSync(candidate), scratch);
  if (
    realpathSync(prior.environment.configDir) !==
    path.join(realpathSync(prior.environment.root), "config")
  )
    throw new Error(
      "artifact run config does not match its saved isolated root",
    );
  const evidenceDir = path.join(
    realpathSync(prior.environment.root),
    "evidence",
    `artifact-${input.runId}`,
  );
  mkdirSync(evidenceDir);
  process.env["CC_CONFIG_DIR"] = realpathSync(prior.environment.configDir);
  delete process.env["CC_ENV"];
  return {
    prior,
    environment: { ...prior.environment, runId: input.runId, evidenceDir },
  };
}
