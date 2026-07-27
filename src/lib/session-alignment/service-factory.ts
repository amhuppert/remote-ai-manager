import { publishEvent } from "@/lib/events/publication";
import { enqueueConversationMessage } from "@/lib/prompt/enqueue-conversation-message";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getSession } from "@/lib/state-store";
import { getDb } from "@/lib/state-store/state-db";

import { createCharterMirrorWriter } from "./mirror";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  usesDigestPointer,
} from "./render";
import { createCharterSnapshotWriter } from "./snapshot";
import { createSessionAlignmentRepo } from "./repo";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "./service";

/**
 * Assemble the production `SessionAlignmentService` over real infrastructure:
 * the alignment repo on the live DB, the render surface, the worktree mirror
 * writer, the SSE broadcaster, the prompt queue (backend resolved per
 * conversation), and the session loader.
 */
export function createSessionAlignmentServiceForProduction(): SessionAlignmentService {
  return createSessionAlignmentService({
    repo: createSessionAlignmentRepo(getDb()),
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      usesDigestPointer,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: createCharterMirrorWriter(),
    snapshot: createCharterSnapshotWriter(),
    broadcast: publishEvent,
    promptQueue: { enqueue: enqueueConversationMessage },
    async loadSession(projectPath, sessionName) {
      const session = await getSession(projectPath, sessionName);
      if (!session) {
        return null;
      }
      return {
        worktreePath: session.worktreePath,
        creationMode: session.creationMode,
      };
    },
  });
}

/**
 * Process-wide production service for callers outside the alignment routes,
 * which own their own instance. Memoized because every instance wraps the same
 * repo and DB, so rebuilding one per call would only add allocation.
 */
export function getSessionAlignmentServiceForProduction(): SessionAlignmentService {
  return getGlobalSingleton("__cc_session_alignment_service", () =>
    createSessionAlignmentServiceForProduction(),
  );
}
