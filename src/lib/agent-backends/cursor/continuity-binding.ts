import type { ContinuityContext } from "../continuity";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { CursorContinuityBinding } from "./continuity";
import { CursorContinuityError } from "./continuity";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import path from "node:path";
import { decodeCursorTaskRef } from "./task-ref";

const logger = createLogger("cursor:continuity-binding");

export interface CursorContinuityBindingDeps {
  storePath(conversationId: string): string;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{ agentBackend: string } | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ worktreePath: string } | null>;
  resolveModel(
    selection: NonNullable<ContinuityContext["modelSelection"]>,
    projectPath: string,
  ): Promise<
    | { ok: true; selection: NonNullable<ContinuityContext["modelSelection"]> }
    | { ok: false; message: string }
  >;
}

export function createCursorContinuityBindingResolver(
  deps: CursorContinuityBindingDeps,
) {
  return async (
    input: ContinuityContext,
    ref?: AgentSessionRef,
  ): Promise<CursorContinuityBinding> => {
    let conversationId = input.conversationId;
    let cwd: string;
    if (ref?.ref.startsWith("{")) {
      const task = decodeCursorTaskRef(ref);
      if (
        task.cwd !==
          path.resolve(input.workingDirectory ?? input.projectPath) ||
        (task.scope &&
          (task.scope.conversationId !== input.conversationId ||
            task.scope.session !== input.sessionName))
      ) {
        throw new CursorContinuityError(
          "rejected",
          "Cursor task ref does not belong to this cwd or conversation",
        );
      }
      conversationId = `task-${task.taskId}`;
      cwd = task.cwd;
    } else {
      if (!conversationId)
        throw new CursorContinuityError(
          "rejected",
          "Cursor continuity requires an explicit conversationId",
        );
      const conversation = await deps.getConversation(
        input.projectPath,
        input.sessionName,
        conversationId,
      );
      if (!conversation || conversation.agentBackend !== "cursor")
        throw new CursorContinuityError(
          "rejected",
          "Cursor conversation is missing or belongs to another backend",
        );
      const scope = scopeRefFromStoreSessionName(input.sessionName);
      const session =
        scope.scope === "project"
          ? null
          : await deps.getSession(input.projectPath, input.sessionName);
      if (!session && scope.scope !== "project")
        throw new CursorContinuityError(
          "rejected",
          "Cursor conversation's session is missing",
        );
      cwd = session?.worktreePath ?? input.projectPath;
    }
    if (!input.modelSelection)
      throw new CursorContinuityError(
        "rejected",
        "Cursor continuity requires a complete modelSelection",
      );
    const model = await deps.resolveModel(
      input.modelSelection,
      input.projectPath,
    );
    if (!model.ok) throw new CursorContinuityError("rejected", model.message);
    logger.info("continuity.bound", { conversationId, cwd });
    return {
      conversationId,
      cwd,
      storePath: deps.storePath(conversationId),
      modelSelection: model.selection,
      mcpServers: {},
    };
  };
}
