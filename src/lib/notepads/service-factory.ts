import { randomUUID } from "node:crypto";
import path from "node:path";
import { getConfigDirPath } from "@/lib/config/loader";
import { publishEvent } from "@/lib/events/publication";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getStateDb } from "@/lib/state-store";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import {
  _resetForTesting,
  tryWithWriteQueue,
  withWriteQueue,
  withWriteQueueSync,
} from "@/lib/state-store/write-queue";
import {
  createNotepadContentStore,
  NOTEPAD_CONTENT_ROOT_DIRNAME,
  type NotepadContentStore,
} from "./content-store";
import {
  createNotepadImageService,
  type NotepadImageService,
} from "./image-service";
import {
  createNotepadInjectionReader,
  type NotepadInjectionReader,
} from "./injection";
import { createNotepadService, type NotepadService } from "./service";

/**
 * One repo per process: it shares the module-level write queue so notepad
 * writes serialize with every other state-store write, and route handlers reuse
 * the same prepared statements as the service.
 */
export function getNotepadsRepo(): NotepadsRepo {
  return getGlobalSingleton("__cc_notepads_repo", () =>
    createNotepadsRepo(getStateDb(), {
      withWriteQueue,
      withWriteQueueSync,
      tryWithWriteQueue,
      _resetForTesting,
    }),
  );
}

/**
 * Durable storage for notepad image bytes. Rooted beside the ticket content
 * store under the config dir, and keyed by notepad id so a notepad's images are
 * removable without knowing which tokens its text still carries.
 */
export function getNotepadContentStore(): NotepadContentStore {
  return getGlobalSingleton("__cc_notepad_content_store", () =>
    createNotepadContentStore({
      contentRoot: path.join(getConfigDirPath(), NOTEPAD_CONTENT_ROOT_DIRNAME),
      listNotepadIdsForProject: (projectPath) =>
        getNotepadsRepo().listNotepadIds(projectPath),
    }),
  );
}

/**
 * The single owner of notepad decisions — write modes, compare-and-swap
 * freshness, name uniqueness, and revision attribution. Every notepad surface
 * (routes, CLI, prompt injection) reaches persistence through this, never
 * through the repo directly, so the enforcement cannot be bypassed by adding a
 * caller.
 */
export function getNotepadService(): NotepadService {
  return getGlobalSingleton("__cc_notepad_service", () =>
    createNotepadService({
      repo: getNotepadsRepo(),
      publish: publishEvent,
      deleteNotepadContent: (notepadId) =>
        getNotepadContentStore().deleteNotepad(notepadId),
      now: () => new Date().toISOString(),
      generateId: () => randomUUID(),
    }),
  );
}

/**
 * The read seam the agent-facing prompt expansion pass uses. Stateless over the
 * service, so it is built per call rather than held as a singleton.
 */
export function getNotepadInjectionReader(): NotepadInjectionReader {
  return createNotepadInjectionReader(getNotepadService());
}

/**
 * Owner of the bytes-plus-row pairing behind the notepad image routes. Reads
 * the notepad through the service above, so a missing notepad is refused with
 * the domain's own not-found rather than a second copy of it.
 */
export function getNotepadImageService(): NotepadImageService {
  return getGlobalSingleton("__cc_notepad_image_service", () =>
    createNotepadImageService({
      notepads: getNotepadService(),
      repo: getNotepadsRepo(),
      contentStore: getNotepadContentStore(),
      now: () => new Date().toISOString(),
      generateId: () => randomUUID(),
    }),
  );
}
