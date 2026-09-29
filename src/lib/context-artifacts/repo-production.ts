import { getStateDb } from "@/lib/state-store/store";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";

// Bind to the shared SQLite handle only when a consumer first needs storage.
let defaultRepo: ContextArtifactsRepo | null = null;

export function getContextArtifactsRepo(): ContextArtifactsRepo {
  defaultRepo ??= createContextArtifactsRepo(getStateDb());
  return defaultRepo;
}
