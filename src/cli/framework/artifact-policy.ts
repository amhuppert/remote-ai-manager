import path from "node:path";
import type { ArtifactPolicy } from "cli-for-agents";

/** The library creates the directory the first time a response needs an artifact. */
export function localArtifactPolicy(): ArtifactPolicy {
  return {
    directory: path.resolve(".cc/temp/cctl-artifacts"),
    forbiddenRoots: [path.resolve(".git")],
  };
}
