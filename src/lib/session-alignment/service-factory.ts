import { publishEvent } from "@/lib/events/publication";
import { enqueueConversationMessage } from "@/lib/prompt/enqueue-conversation-message";
import { getSession } from "@/lib/state-store";
import { getDb } from "@/lib/state-store/state-db";

import { createCharterMirrorWriter } from "./mirror";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
} from "./render";
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
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: createCharterMirrorWriter(),
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
