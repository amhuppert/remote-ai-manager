/**
 * Test-only fixture: runs a REAL `CodexConversationRuntime` against a fake
 * provider whose thread resume rejects with the SDK's no-rollout message, and
 * returns the adapter's genuine stale-resume turn result. Lives inside the
 * backend seam (like `testfake-backend`) so integration tests above the seam
 * exercise the real adapter without deep-importing its internals. Never runs
 * in production.
 */

import { createFakeCodexProvider } from "./fake-codex-provider";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "../schemas";
import type { ConversationBackendTurnResult } from "../conversation";
import {
  CodexConversationRuntime,
  type CodexConversationRuntimeDeps,
} from "../codex/conversation-runtime";

export const STALE_CODEX_RESUME_REF: AgentSessionRef = {
  backend: "codex",
  ref: "thread-gone",
};

const STALE_CODEX_MODEL_SELECTION = {
  modelId: "gpt-5.4",
  parameters: { reasoning: "high", fast: "false" },
} satisfies BackendModelSelection;

function makeStaleResumeDeps(): CodexConversationRuntimeDeps {
  const { deps } = createFakeCodexProvider();
  return {
    ...deps,
    createAppServer(options) {
      const client = deps.createAppServer(options);
      return {
        ...client,
        async request(method, params) {
          if (method === "thread/resume")
            throw new Error(
              `thread/resume: no rollout found for thread id "${STALE_CODEX_RESUME_REF.ref}"`,
            );
          if (method === "thread/start")
            throw new Error("stale resume must not fall back to thread/start");
          return client.request(method, params);
        },
      };
    },
  };
}

export async function runStaleCodexResumeTurn(identity: {
  conversationId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
}): Promise<ConversationBackendTurnResult> {
  const runtime = new CodexConversationRuntime(
    {
      executionClass: "ordinary-conversation" as const,
      ...identity,
      conversationTarget: sessionConversationTarget(
        identity.projectName,
        identity.sessionName,
        identity.conversationId,
      ),
      persistedRef: STALE_CODEX_RESUME_REF,
      modelSelection: STALE_CODEX_MODEL_SELECTION,
      sessionInstructions: [],
      tooling: {},
    },
    makeStaleResumeDeps(),
  );
  return runtime.sendTurn({
    promptText: "Continue where we left off",
    imageRefs: [],
    sessionInstructions: [],
    modelSelection: STALE_CODEX_MODEL_SELECTION,
    autonomous: false,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}
