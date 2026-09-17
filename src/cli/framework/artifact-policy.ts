import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactPolicy } from "cli-for-agents";

export async function localArtifactPolicy(): Promise<ArtifactPolicy> {
  const directory = path.resolve(".cc/temp/cctl-artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { directory, forbiddenRoots: [path.resolve(".git")] };
}
