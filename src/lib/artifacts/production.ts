import path from "node:path";
import { resolveConfigDir } from "@/lib/config/loader";
import { createArtifactStore, type ArtifactStore } from "./store";

/** The installation's artifact store, under its config directory. */
export function getArtifactStore(): ArtifactStore {
  return createArtifactStore({ root: path.join(resolveConfigDir(), "artifacts") });
}
