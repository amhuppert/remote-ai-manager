import {
  checkProfileResolves,
  createAgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";

import { createRunTemplateService, type RunTemplateService } from "./service";
import { createRunTemplateStorage } from "./storage";

/**
 * The run template library as the server runs it: templates in the config
 * directory, and profiles checked against the library a seat's spawn
 * resolves through.
 */
export function createProductionRunTemplateService(): RunTemplateService {
  const library = createAgentProfileLibraryService();
  return createRunTemplateService({
    storage: createRunTemplateStorage(),
    profiles: {
      check: (projectPath, ref) =>
        checkProfileResolves(library, projectPath, ref),
    },
  });
}
