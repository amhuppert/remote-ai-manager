import { readConfig } from "@/lib/config/loader";
import { resolveCompactionConfig } from "@/lib/config/cascade";
import { publishEvent } from "@/lib/events/publication";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { readTranscriptEntriesWithSeq } from "@/lib/prompt/transcript";
import { coreTaskLane } from "@/lib/supervision/handles";
import { getContextArtifactsRepo } from "./repo-production";
import { createCompactionService, type CompactionService } from "./service";

// Routes and ticket attachments must share the service's single-flight map.
// Construction stays lazy so importing a consumer never opens the database.
let defaultService: CompactionService | null = null;

export function getCompactionService(): CompactionService {
  defaultService ??= createCompactionService({
    executeTaskRun: async (input) => (await coreTaskLane())(input),
    taskLane: coreTaskLane,
    readEntries: readTranscriptEntriesWithSeq,
    repo: getContextArtifactsRepo(),
    resolveConfig: async (projectPath) =>
      resolveCompactionConfig(
        await readConfig(),
        await readRepoConfig(projectPath),
      ),
    broadcast: publishEvent,
    now: () => new Date().toISOString(),
  });
  return defaultService;
}
